import { afterEach, describe, expect, it } from "vitest";
import { finalizeEvent } from "nostr-tools";
import {
  SimplePool,
  useWebSocketImplementation,
} from "nostr-tools/pool";

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
});
