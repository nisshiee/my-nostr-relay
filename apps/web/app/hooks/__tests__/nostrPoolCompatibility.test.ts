import { afterEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent } from "nostr-tools";
import {
  SimplePool,
  useWebSocketImplementation,
} from "nostr-tools/pool";
import {
  subscribeTimeline,
  TIMELINE_RECONNECT_OVERLAP_SECONDS,
} from "../../lib/timelineSubscription";

interface MockMessageEvent {
  data: string;
}

interface MockCloseEvent {
  message: string;
}

class MockWebSocket {
  static readonly OPEN = 1;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readonly sent: string[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: MockCloseEvent) => void) | null = null;
  onmessage: ((event: MockMessageEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    });
  }

  send(message: string): void {
    this.sent.push(message);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ message: "mock closed" }));
  }

  receive(message: string): void {
    this.onmessage?.({ data: message });
  }
}

async function waitFor(
  predicate: () => boolean,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`${label}の待機がタイムアウトしました`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function request(socket: MockWebSocket): ["REQ", string, ...unknown[]] {
  const message = socket.sent.find((candidate) => candidate.includes('"REQ"'));
  if (!message) throw new Error("REQが送信されていません");
  return JSON.parse(message) as ["REQ", string, ...unknown[]];
}

function requests(socket: MockWebSocket): ["REQ", string, ...unknown[]][] {
  return socket.sent
    .filter((candidate) => candidate.includes('"REQ"'))
    .map((candidate) => JSON.parse(candidate) as ["REQ", string, ...unknown[]]);
}

function signedEvent(kind: 1 | 6, createdAt: number, content: string) {
  const secretKey = new Uint8Array(32);
  secretKey[31] = kind === 1 ? 1 : 2;
  return finalizeEvent({
    kind,
    created_at: createdAt,
    tags: kind === 6 ? [["e", "a".repeat(64)]] : [],
    content,
  }, secretKey);
}

afterEach(() => {
  MockWebSocket.instances = [];
  useWebSocketImplementation(globalThis.WebSocket);
});

describe("nostr-tools SimplePool compatibility", () => {
  it("切断後に再接続して同じ購読を再送する", async () => {
    useWebSocketImplementation(MockWebSocket as unknown as typeof WebSocket);
    const pool = new SimplePool({ enableReconnect: true, enablePing: true });
    const subscription = pool.subscribeMany(
      ["wss://relay.example"],
      { kinds: [1] },
      { onevent() {}, maxWait: 1_000 },
    );

    await waitFor(
      () => MockWebSocket.instances.length === 1
        && MockWebSocket.instances[0]!.sent.some((message) => message.includes('"REQ"')),
      "最初の購読",
    );

    const relay = [...(
      pool as unknown as {
        relays: Map<string, { resubscribeBackoff: number[] }>;
      }
    ).relays.values()][0]!;
    relay.resubscribeBackoff = [5];
    MockWebSocket.instances[0]!.close();

    await waitFor(
      () => MockWebSocket.instances.length === 2
        && MockWebSocket.instances[1]!.sent.some((message) => message.includes('"REQ"')),
      "再接続後の購読",
    );

    expect(request(MockWebSocket.instances[1]!)[2]).toEqual(
      request(MockWebSocket.instances[0]!)[2],
    );

    subscription.close("テスト終了");
    pool.destroy();
  });

  it("複数リレーから届いた同一event idを一度だけ通知する", async () => {
    useWebSocketImplementation(MockWebSocket as unknown as typeof WebSocket);
    const pool = new SimplePool({ enableReconnect: true, enablePing: true });
    const received: string[] = [];
    const subscription = pool.subscribeMany(
      ["wss://relay-one.example", "wss://relay-two.example"],
      { kinds: [1] },
      {
        onevent(event) {
          received.push(event.id);
        },
        maxWait: 1_000,
      },
    );

    await waitFor(
      () => MockWebSocket.instances.length === 2
        && MockWebSocket.instances.every((socket) =>
          socket.sent.some((message) => message.includes('"REQ"'))),
      "複数リレーの購読",
    );

    const secretKey = new Uint8Array(32);
    secretKey[31] = 1;
    const event = finalizeEvent({
      kind: 1,
      created_at: 1,
      tags: [],
      content: "duplicate event",
    }, secretKey);

    for (const socket of MockWebSocket.instances) {
      const subscriptionId = request(socket)[1];
      socket.receive(JSON.stringify(["EVENT", subscriptionId, event]));
    }

    await waitFor(() => received.length === 1, "event通知");
    expect(received).toEqual([event.id]);

    subscription.close("テスト終了");
    pool.destroy();
  });

  it("ソケットを開いたまま CLOSED になった一時障害の購読だけを再作成する", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    useWebSocketImplementation(MockWebSocket as unknown as typeof WebSocket);
    const pool = new SimplePool({ enableReconnect: false, enablePing: false });
    const subscription = subscribeTimeline(
      pool,
      ["wss://relay.example"],
      { kinds: [1, 6] },
      { onevent() {} },
      { retryBaseMs: 5, retryMaxMs: 5, random: () => 0.5 },
    );
    await waitFor(() => requests(MockWebSocket.instances[0]!).length === 1, "最初の購読");
    const socket = MockWebSocket.instances[0]!;
    const firstId = requests(socket)[0]![1];
    socket.receive(JSON.stringify(["CLOSED", firstId, "error: temporarily unavailable"]));

    await waitFor(() => requests(socket).length === 2, "CLOSED 後の再購読");
    expect(socket.readyState).toBe(MockWebSocket.OPEN);
    expect(requests(socket)[1]![1]).not.toBe(firstId);

    subscription.close("テスト終了");
    pool.destroy();
  });

  it("複数リレーのうち CLOSED になった購読だけを回復する", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    useWebSocketImplementation(MockWebSocket as unknown as typeof WebSocket);
    const pool = new SimplePool({ enableReconnect: false, enablePing: false });
    const subscription = subscribeTimeline(
      pool,
      ["wss://relay-one.example", "wss://relay-two.example"],
      { kinds: [1, 6] },
      { onevent() {} },
      { retryBaseMs: 5, retryMaxMs: 5, random: () => 0.5 },
    );
    await waitFor(
      () => MockWebSocket.instances.length === 2
        && MockWebSocket.instances.every((socket) => requests(socket).length === 1),
      "複数リレーの購読",
    );
    const failed = MockWebSocket.instances[0]!;
    const healthy = MockWebSocket.instances[1]!;
    failed.receive(JSON.stringify(["CLOSED", requests(failed)[0]![1], "error: temporarily unavailable"]));
    await waitFor(() => requests(failed).length === 2, "個別購読の回復");
    expect(requests(healthy)).toHaveLength(1);
    expect(healthy.readyState).toBe(MockWebSocket.OPEN);

    subscription.close("テスト終了");
    pool.destroy();
  });

  it("再購読の watermark をリレーごとに独立して保持する", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    useWebSocketImplementation(MockWebSocket as unknown as typeof WebSocket);
    const pool = new SimplePool({ enableReconnect: false, enablePing: false });
    const subscription = subscribeTimeline(
      pool,
      ["wss://relay-one.example", "wss://relay-two.example"],
      { kinds: [1] },
      { onevent() {} },
      { retryBaseMs: 5, retryMaxMs: 5, random: () => 0.5 },
    );
    await waitFor(
      () => MockWebSocket.instances.length === 2
        && MockWebSocket.instances.every((socket) => requests(socket).length === 1),
      "複数リレーの購読",
    );

    const advanced = MockWebSocket.instances.find((socket) => socket.url.includes("relay-one"))!;
    const lagging = MockWebSocket.instances.find((socket) => socket.url.includes("relay-two"))!;
    const createdAt = Math.floor(Date.now() / 1000);
    advanced.receive(JSON.stringify([
      "EVENT",
      requests(advanced)[0]![1],
      signedEvent(1, createdAt, "advanced relay event"),
    ]));
    lagging.receive(JSON.stringify([
      "CLOSED",
      requests(lagging)[0]![1],
      "error: temporarily unavailable",
    ]));

    await waitFor(() => requests(lagging).length === 2, "遅いリレーの再購読");
    expect(requests(lagging)[1]![2]).toEqual({ kinds: [1] });

    subscription.close("テスト終了");
    pool.destroy();
  });

  it("一時障害が続いても再試行上限で停止する", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    useWebSocketImplementation(MockWebSocket as unknown as typeof WebSocket);
    const pool = new SimplePool({ enableReconnect: false, enablePing: false });
    const terminal = vi.fn();
    const subscription = subscribeTimeline(
      pool,
      ["wss://relay.example"],
      { kinds: [1, 6] },
      { onevent() {}, onterminalclose: terminal },
      { retryLimit: 2, retryBaseMs: 5, retryMaxMs: 5, random: () => 0.5 },
    );
    await waitFor(() => requests(MockWebSocket.instances[0]!).length === 1, "最初の購読");
    const socket = MockWebSocket.instances[0]!;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const current = requests(socket).at(-1)!;
      socket.receive(JSON.stringify(["CLOSED", current[1], "relay connection closed"]));
      await waitFor(() => requests(socket).length === attempt + 1, `${attempt}回目の再購読`);
    }
    socket.receive(JSON.stringify(["CLOSED", requests(socket).at(-1)![1], "relay connection closed"]));
    await waitFor(() => terminal.mock.calls.length === 1, "再試行上限");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests(socket)).toHaveLength(3);

    subscription.close("テスト終了");
    pool.destroy();
  });

  it.each([
    "auth-required: sign in",
    "rate-limited: slow down",
    "blocked: policy",
    "invalid: filter",
  ])("認証や恒久エラーを無条件に再試行しない: %s", async (reason) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    useWebSocketImplementation(MockWebSocket as unknown as typeof WebSocket);
    const pool = new SimplePool({ enableReconnect: false, enablePing: false });
    const terminal = vi.fn();
    const subscription = subscribeTimeline(
      pool,
      ["wss://relay.example"],
      { kinds: [1, 6] },
      { onevent() {}, onterminalclose: terminal },
      { retryBaseMs: 5, retryMaxMs: 5, random: () => 0.5 },
    );
    await waitFor(() => requests(MockWebSocket.instances[0]!).length === 1, "最初の購読");
    const socket = MockWebSocket.instances[0]!;
    socket.receive(JSON.stringify(["CLOSED", requests(socket)[0]![1], reason]));
    await waitFor(() => terminal.mock.calls.length === 1, "恒久終了通知");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests(socket)).toHaveLength(1);

    subscription.close("テスト終了");
    pool.destroy();
  });

  it.each([1, 6] as const)("未来時刻の kind:%s で再接続 since を未来へ進めない", async (kind) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    useWebSocketImplementation(MockWebSocket as unknown as typeof WebSocket);
    const pool = new SimplePool({ enableReconnect: false, enablePing: false });
    const subscription = subscribeTimeline(
      pool,
      ["wss://relay.example"],
      { kinds: [1, 6], limit: 500 },
      { onevent() {} },
      { retryBaseMs: 5, retryMaxMs: 5, random: () => 0.5 },
    );
    await waitFor(() => MockWebSocket.instances.length === 1 && requests(MockWebSocket.instances[0]!).length === 1, "最初の購読");
    const receivedAt = Math.floor(Date.now() / 1000);
    const firstSocket = MockWebSocket.instances[0]!;
    const firstRequest = requests(firstSocket)[0]!;
    firstSocket.receive(JSON.stringify([
      "EVENT",
      firstRequest[1],
      signedEvent(kind, receivedAt + 2 * 60 * 60, `future-${kind}`),
    ]));
    firstSocket.close();

    await waitFor(() => MockWebSocket.instances.length === 2 && requests(MockWebSocket.instances[1]!).length === 1, "安全な再購読");
    const recoveredFilter = requests(MockWebSocket.instances[1]!)[0]![2];
    expect(recoveredFilter).toEqual({ kinds: [1, 6], limit: 500 });

    subscription.close("テスト終了");
    pool.destroy();
  });

  it("同じ秒の遅配を overlap で回収し event id で重複を除く", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    useWebSocketImplementation(MockWebSocket as unknown as typeof WebSocket);
    const pool = new SimplePool({ enableReconnect: false, enablePing: false });
    const received: string[] = [];
    const subscription = subscribeTimeline(
      pool,
      ["wss://relay.example"],
      { kinds: [1] },
      { onevent(event) { received.push(event.id); } },
      { retryBaseMs: 5, retryMaxMs: 5, random: () => 0.5 },
    );
    await waitFor(() => MockWebSocket.instances.length === 1 && requests(MockWebSocket.instances[0]!).length === 1, "最初の購読");
    const createdAt = Math.floor(Date.now() / 1000);
    const first = signedEvent(1, createdAt, "first");
    const firstSocket = MockWebSocket.instances[0]!;
    firstSocket.receive(JSON.stringify(["EVENT", requests(firstSocket)[0]![1], first]));
    firstSocket.close();
    await waitFor(() => MockWebSocket.instances.length === 2 && requests(MockWebSocket.instances[1]!).length === 1, "overlap 再購読");
    const secondSocket = MockWebSocket.instances[1]!;
    const secondRequest = requests(secondSocket)[0]!;
    const filter = secondRequest[2] as { since: number };
    expect(filter.since).toBe(createdAt - TIMELINE_RECONNECT_OVERLAP_SECONDS);
    const delayed = signedEvent(1, createdAt, "delayed");
    secondSocket.receive(JSON.stringify(["EVENT", secondRequest[1], first]));
    secondSocket.receive(JSON.stringify(["EVENT", secondRequest[1], delayed]));
    await waitFor(() => received.length === 2, "同秒遅配");
    expect(received).toEqual([first.id, delayed.id]);

    subscription.close("テスト終了");
    pool.destroy();
  });

  it("イベント未受信なら再購読でも元 filter を変更しない", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    useWebSocketImplementation(MockWebSocket as unknown as typeof WebSocket);
    const pool = new SimplePool({ enableReconnect: false, enablePing: false });
    const originalFilter = { kinds: [1, 6] as number[], authors: ["author"], limit: 500 };
    const subscription = subscribeTimeline(
      pool,
      ["wss://relay.example"],
      originalFilter,
      { onevent() {} },
      { retryBaseMs: 5, retryMaxMs: 5, random: () => 0.5 },
    );
    await waitFor(() => MockWebSocket.instances.length === 1 && requests(MockWebSocket.instances[0]!).length === 1, "最初の購読");
    MockWebSocket.instances[0]!.close();
    await waitFor(() => MockWebSocket.instances.length === 2 && requests(MockWebSocket.instances[1]!).length === 1, "filter 維持再購読");
    expect(requests(MockWebSocket.instances[1]!)[0]![2]).toEqual(originalFilter);

    subscription.close("テスト終了");
    pool.destroy();
  });
});
