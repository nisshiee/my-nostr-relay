// @vitest-environment jsdom

import React, { type ComponentProps, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveCanvas } from "../LiveCanvas";
import type { Card, NoteCard as Note, ThreadCard } from "../../lib/types";

vi.mock("../canvas/CanvasScene", () => ({
  CanvasScene: ({ items, heldIds, allowNative, settingsOpen, settingsContent, onSettingsClose }: {
    settingsOpen?: boolean; settingsContent?: ReactNode; onSettingsClose?: () => void;
    allowNative: boolean;
    items: { id: string; card: Card; content: ReactNode }[];
    heldIds: ReadonlySet<string>;
  }) => <div data-testid="scene" data-allow-native={String(allowNative)}>{settingsOpen && <div role="dialog">{settingsContent}<button onClick={onSettingsClose}>閉じる</button></div>}{items.map(item => (
    <section key={item.id} data-slot={item.id} data-score={item.card.score} data-sources={item.card.scoreSources?.length} data-event-ids={item.card.type === "thread" ? item.card.notes.map(note => note.eventId).join(",") : ""} data-source-ids={item.card.scoreSources?.map(source => source.eventId).join(",")} data-count={item.card.type === "thread" ? item.card.notes.length : 1} data-held={heldIds.has(item.id)}>{item.content}</section>
  ))}</div>,
}));
vi.mock("../CanvasHeader", () => ({
  CanvasHeader: ({ onAddDraft, onOpenSettings, onOpenProfile }: { onAddDraft: () => void; onOpenSettings?: () => void; onOpenProfile: () => void }) => <><button onClick={() => onAddDraft()}>新規投稿</button><button onClick={onOpenSettings}>設定</button><button onClick={onOpenProfile}>自分の投稿</button></>,
}));
vi.mock("../ComposeCard", () => ({
  ComposeCard: ({ slotId, onPublish, onHold }: ComponentProps<typeof import("../ComposeCard").ComposeCard>) => (
    <div>
      <button onClick={() => onHold?.(slotId)}>編集中</button>
      <button onClick={() => onPublish(slotId, makeNote(slotId, "published-event"))}>公開完了</button>
    </div>
  ),
}));
vi.mock("../NoteCard", () => ({
  NoteCard: ({ note, onHold, onRelease, onReplyPublish }: ComponentProps<typeof import("../NoteCard").NoteCard>) => (
    <div>
      <span>{note.content}</span>
      <button onClick={onHold}>固定</button>
      <button onClick={onRelease}>解除</button>
      <button onClick={() => {
        const reply = makeNote("first-pending", "first-pending-event");
        onReplyPublish?.({ ...reply, id: reply.eventId, sig: "sig", kind: 1 }, reply, note);
      }}>最初の返信公開</button>
    </div>
  ),
}));
vi.mock("../ThreadCard", () => ({
  ThreadCard: ({ thread, onReplyPublish, onHold }: ComponentProps<typeof import("../ThreadCard").ThreadCard>) => <div>
    スレッド
    <button onClick={onHold}>スレッド固定</button>
    <button onClick={() => {
      const reply = makeNote("pending", "pending-event");
      onReplyPublish?.({ ...reply, id: reply.eventId, sig: "sig", kind: 1 }, reply, thread.slotId);
    }}>返信公開</button>
  </div>,
}));
vi.mock("../UserProfileModal", () => ({ UserProfileModal: ({ pubkey }: { pubkey: string }) => <div data-testid="profile-modal">{pubkey}</div> }));
vi.mock("../HashtagModal", () => ({ HashtagModal: () => null }));

afterEach(() => { cleanup(); vi.useRealTimers(); });

function makeNote(slotId = "slot-a", eventId = "event-a"): Note {
  return { type: "note", slotId, eventId, pubkey: "me", content: "テスト投稿", tags: [], created_at: Math.floor(Date.now() / 1000), score: 1 };
}

function makeProps(): ComponentProps<typeof LiveCanvas> {
  return {
    notes: [], threadCards: [], profiles: new Map(), reactions: new Map(),
    status: "connected", pubkey: "me",
    publishEvent: vi.fn(), publishedSlotMapRef: { current: new Map() },
    sendReaction: vi.fn(), sendRepost: vi.fn(), watchReactions: vi.fn(() => vi.fn()),
    cache: {} as ComponentProps<typeof LiveCanvas>["cache"],
    onLogout: vi.fn(), showSignerControl: false, onManageSigner: vi.fn(),
    isProcessing: false, recentEmojis: [], emojiSets: [], looseEmojis: [],
    fetchProfiles: vi.fn(), fetchUserRecentNotes: vi.fn(), fetchHashtagNotes: vi.fn(),
    isFollowing: () => false, follow: vi.fn(), unfollow: vi.fn(),
  };
}

describe("LiveCanvas のカード統合", () => {
  it("Yoを通常投稿とは別のスロットで描画し、送信者のプロフィールを開ける", () => {
    const props = makeProps();
    const sender = "a".repeat(64);
    const note = makeNote();
    const { container } = render(<LiveCanvas {...props} notes={[note]}
      profiles={new Map([[sender, { name: "Yo送信者" }]])}
      yoCards={[{ type: "yo", slotId: "yo:unique", eventId: "unique", pubkey: sender, score: 0, created_at: note.created_at }]} />);
    expect(container.querySelectorAll("[data-slot]")).toHaveLength(2);
    expect(container.querySelector('[data-slot="yo:unique"]')?.textContent).toContain("Yo");
    fireEvent.click(screen.getByRole("button", { name: "Yo送信者のプロフィールを開く" }));
    expect(screen.getByTestId("profile-modal").textContent).toBe(sender);
  });

  it("自分のプロフィールを取得し、ヘッダーから同じ投稿一覧モーダルを開く", () => {
    const props = makeProps();
    render(<LiveCanvas {...props} />);
    expect(props.fetchProfiles).toHaveBeenCalledWith(["me"]);
    fireEvent.click(screen.getByRole("button", { name: "自分の投稿" }));
    expect(screen.getByTestId("profile-modal").textContent).toBe("me");
  });
  it.each([false,true])("空/処理中でもヘッダーから設定を開閉できる processing=%s", isProcessing => {
    render(<LiveCanvas {...makeProps()} isProcessing={isProcessing} settingsContent={<span>本人確認fixture</span>} />);
    fireEvent.click(screen.getByRole('button',{name:'設定'}));expect(screen.getByRole('dialog').textContent).toContain('本人確認fixture');
    fireEvent.click(screen.getByRole('button',{name:'閉じる'}));expect(screen.queryByRole('dialog')).toBeNull();
  });
  it("画像gateとnative描画可否を同じ値で連動させる", () => {
    const props = {...makeProps(), notes: [makeNote()]};
    const {rerender} = render(<LiveCanvas {...props} />);
    expect(screen.getByTestId('scene').dataset.allowNative).toBe('false');
    rerender(<LiveCanvas {...props} nativeEnabled />);
    expect(screen.getByTestId('scene').dataset.allowNative).toBe('true');
  });
  it("空フィードでも下書きを作成し、公開時にslotIdを引き継いで固定を解除する", () => {
    const props = makeProps();
    const { container } = render(<LiveCanvas {...props} />);
    fireEvent.click(screen.getByText("新規投稿"));
    const draftSlot = container.querySelector("[data-slot]")!.getAttribute("data-slot");
    fireEvent.click(screen.getByText("編集中"));
    expect(container.querySelector("[data-slot]")!.getAttribute("data-held")).toBe("true");
    fireEvent.click(screen.getByText("公開完了"));
    expect(screen.getByText("テスト投稿")).toBeDefined();
    expect(container.querySelector("[data-slot]")!.getAttribute("data-slot")).toBe(draftSlot);
    expect(container.querySelector("[data-slot]")!.getAttribute("data-held")).toBe("false");
    expect(props.publishedSlotMapRef.current!.get("published-event")).toBe(draftSlot);
  });

  it("カード操作のholdをシーンに渡し、解除を反映する", () => {
    const props = makeProps();
    props.notes = [makeNote()];
    const { container } = render(<LiveCanvas {...props} />);
    fireEvent.click(screen.getByText("固定"));
    expect(container.querySelector("[data-slot]")!.getAttribute("data-held")).toBe("true");
    fireEvent.click(screen.getByText("解除"));
    expect(container.querySelector("[data-slot]")!.getAttribute("data-held")).toBe("false");
  });

  it("ノートとスレッドの同一slotIdを二重描画しない", () => {
    const props = makeProps();
    const note = makeNote();
    props.notes = [note];
    props.threadCards = [{ type: "thread", scoreSources: [], slotId: note.slotId, pubkey: note.pubkey,
      created_at: note.created_at, score: 1, notes: [note], eventIds: new Set([note.eventId]) }];
    const { container } = render(<LiveCanvas {...props} />);
    expect(container.querySelectorAll("[data-slot]")).toHaveLength(1);
    expect(screen.getByText("スレッド")).toBeDefined();
    expect(screen.queryByText("テスト投稿")).toBeNull();
  });
});

function makeThread(): ThreadCard {
  const root = { ...makeNote(), pubkey: "other", created_at: Math.floor(Date.now() / 1000) - 7200 };
  return { type: "thread", slotId: root.slotId, pubkey: root.pubkey, created_at: root.created_at, score: 1,
    notes: [root], eventIds: new Set([root.eventId]), scoreSources: [root] };
}

describe("共通採点と保留返信の寿命", () => {
  it("スレッドも10秒tickで減衰し、単独と同じ採点元なら同点になる", () => {
    vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
    const thread = makeThread(); const single = { ...makeNote("single", "single"), pubkey: "other", created_at: thread.created_at };
    const { container } = render(<LiveCanvas {...makeProps()} notes={[single]} threadCards={[thread]} />);
    const score = (slot: string) => Number(container.querySelector(`[data-slot="${slot}"]`)!.getAttribute("data-score"));
    expect(score(thread.slotId)).toBe(.0625); expect(score("single")).toBe(.0625);
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(score(thread.slotId)).toBeLessThan(.0625); expect(score(thread.slotId)).toBe(score("single"));
  });
  it("保持元が消えても保留返信を同じslotに表示し、60秒期限で消す", () => {
    vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
    const props = makeProps(); const thread = makeThread();
    const { container, rerender } = render(<LiveCanvas {...props} threadCards={[thread]} />);
    fireEvent.click(screen.getByText("返信公開"));
    rerender(<LiveCanvas {...props} threadCards={[]} />);
    const element = container.querySelector(`[data-slot="${thread.slotId}"]`)!;
    expect(element.getAttribute("data-count")).toBe("2");
    expect(element.getAttribute("data-sources")).toBe("1");
    expect(element.getAttribute("data-score")).toBe("1");
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(container.querySelectorAll("[data-slot]")).toHaveLength(0);
    expect(props.publishedSlotMapRef.current.has("pending-event")).toBe(false);
  });
  it("保留返信のリレー到着を二重表示せず、期限後も実カードを残す", () => {
    vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
    const props = makeProps(); const thread = makeThread();
    const { container, rerender } = render(<LiveCanvas {...props} threadCards={[thread]} />);
    fireEvent.click(screen.getByText("返信公開"));
    const reply = makeNote("pending", "pending-event");
    const echoed = { ...thread, notes: [...thread.notes, reply], eventIds: new Set([...thread.eventIds, reply.eventId]), scoreSources: [reply], created_at: reply.created_at };
    rerender(<LiveCanvas {...props} threadCards={[echoed]} />);
    expect(container.querySelectorAll("[data-slot]")).toHaveLength(1);
    expect(container.querySelector("[data-slot]")!.getAttribute("data-count")).toBe("2");
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(container.querySelectorAll("[data-slot]")).toHaveLength(1);
    expect(props.publishedSlotMapRef.current.has("pending-event")).toBe(false);
  });
  it("スレッドも通常カードと同じholdを共通シーンへ渡す", () => {
    const thread = makeThread(); const { container } = render(<LiveCanvas {...makeProps()} threadCards={[thread]} />);
    fireEvent.click(screen.getByText("スレッド固定"));
    expect(container.querySelector("[data-slot]")!.getAttribute("data-held")).toBe("true");
  });
});

describe("独立レビューで指摘された保留返信の境界", () => {
  it("単独への返信からさらに返信しても1slotに3投稿を保持し、各保留期限を独立に扱う", () => {
    vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
    const props = makeProps(); const root = makeNote();
    const { container, rerender } = render(<LiveCanvas {...props} notes={[root]} />);
    fireEvent.click(screen.getByText("最初の返信公開"));
    act(() => { vi.advanceTimersByTime(30_000); });
    fireEvent.click(screen.getByText("返信公開"));
    const card = () => container.querySelector("[data-slot]")!;
    expect(container.querySelectorAll("[data-slot]")).toHaveLength(1);
    expect(card().getAttribute("data-event-ids")).toBe("event-a,first-pending-event,pending-event");
    expect(card().getAttribute("data-source-ids")).toBe("event-a,first-pending-event,pending-event");
    // 元投稿も剪定。最初の保留が期限切れでも次の保留は生存する。
    rerender(<LiveCanvas {...props} notes={[]} />);
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(container.querySelectorAll("[data-slot]")).toHaveLength(1);
    expect(card().getAttribute("data-event-ids")).toBe("event-a,first-pending-event,pending-event");
    expect(card().getAttribute("data-source-ids")).toBe("pending-event");
    expect(props.publishedSlotMapRef.current.has("first-pending-event")).toBe(false);
    expect(props.publishedSlotMapRef.current.has("pending-event")).toBe(true);
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(container.querySelectorAll("[data-slot]")).toHaveLength(0);
  });
  it("返信先が保持中なら最初の保留期限後もその投稿を共通の採点元として残す", () => {
    vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
    const props = makeProps(); const root = makeNote();
    const { container } = render(<LiveCanvas {...props} notes={[root]} />);
    fireEvent.click(screen.getByText("最初の返信公開"));
    act(() => { vi.advanceTimersByTime(30_000); });
    fireEvent.click(screen.getByText("返信公開"));
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(container.querySelector("[data-slot]")!.getAttribute("data-source-ids")).toBe("event-a,pending-event");
  });
  it("アカウント変更で保留返信・下書き・holdとslot対応をまとめて破棄する", () => {
    const props = makeProps(); const thread = makeThread();
    const { container, rerender } = render(<LiveCanvas {...props} threadCards={[thread]} />);
    fireEvent.click(screen.getByText("スレッド固定"));
    fireEvent.click(screen.getByText("返信公開"));
    fireEvent.click(screen.getByText("新規投稿"));
    expect(props.publishedSlotMapRef.current.has("pending-event")).toBe(true);
    rerender(<LiveCanvas {...props} pubkey="next-owner" threadCards={[]} />);
    expect(container.querySelectorAll("[data-slot]")).toHaveLength(0);
    expect(props.publishedSlotMapRef.current.has("pending-event")).toBe(false);
    rerender(<LiveCanvas {...props} pubkey="next-owner" threadCards={[thread]} />);
    expect(container.querySelector("[data-slot]")!.getAttribute("data-held")).toBe("false");
    expect(container.querySelector("[data-slot]")!.getAttribute("data-count")).toBe("1");
  });
});
