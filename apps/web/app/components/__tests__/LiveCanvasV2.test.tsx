// @vitest-environment jsdom

import React, { type ComponentProps, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveCanvasV2 } from "../LiveCanvasV2";
import type { NoteCard as Note } from "../../lib/types";

vi.mock("../v2/CanvasScene", () => ({
  CanvasScene: ({ items, heldIds, allowNative }: {
    allowNative: boolean;
    items: { id: string; content: ReactNode }[];
    heldIds: ReadonlySet<string>;
  }) => <div data-testid="scene" data-allow-native={String(allowNative)}>{items.map(item => (
    <section key={item.id} data-slot={item.id} data-held={heldIds.has(item.id)}>{item.content}</section>
  ))}</div>,
}));
vi.mock("../CanvasHeader", () => ({
  CanvasHeader: ({ onAddDraft }: { onAddDraft: () => void }) => <button onClick={() => onAddDraft()}>新規投稿</button>,
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
  NoteCard: ({ note, onHold, onRelease }: ComponentProps<typeof import("../NoteCard").NoteCard>) => (
    <div>
      <span>{note.content}</span>
      <button onClick={onHold}>固定</button>
      <button onClick={onRelease}>解除</button>
    </div>
  ),
}));
vi.mock("../ThreadCard", () => ({
  ThreadCard: () => <div>スレッド</div>,
}));
vi.mock("../UserProfileModal", () => ({ UserProfileModal: () => null }));
vi.mock("../HashtagModal", () => ({ HashtagModal: () => null }));

afterEach(cleanup);

function makeNote(slotId = "slot-a", eventId = "event-a"): Note {
  return { type: "note", slotId, eventId, pubkey: "me", content: "テスト投稿", tags: [], created_at: Math.floor(Date.now() / 1000), score: 1 };
}

function makeProps(): ComponentProps<typeof LiveCanvasV2> {
  return {
    notes: [], threadCards: [], profiles: new Map(), reactions: new Map(),
    status: "connected", pubkey: "me", npub: null,
    publishEvent: vi.fn(), publishedSlotMapRef: { current: new Map() },
    sendReaction: vi.fn(), sendRepost: vi.fn(),
    cache: {} as ComponentProps<typeof LiveCanvasV2>["cache"],
    onLogout: vi.fn(), showSignerControl: false, onManageSigner: vi.fn(),
    isProcessing: false, recentEmojis: [], emojiSets: [], looseEmojis: [],
    fetchProfiles: vi.fn(), fetchUserRecentNotes: vi.fn(), fetchHashtagNotes: vi.fn(),
    isFollowing: () => false, follow: vi.fn(), unfollow: vi.fn(),
  };
}

describe("LiveCanvasV2 のカード統合", () => {
  it("画像gateとnative描画可否を同じ値で連動させる", () => {
    const props = {...makeProps(), notes: [makeNote()]};
    const {rerender} = render(<LiveCanvasV2 {...props} />);
    expect(screen.getByTestId('scene').dataset.allowNative).toBe('false');
    rerender(<LiveCanvasV2 {...props} nativeImagesEnabled />);
    expect(screen.getByTestId('scene').dataset.allowNative).toBe('true');
  });
  it("空フィードでも下書きを作成し、公開時にslotIdを引き継いで固定を解除する", () => {
    const props = makeProps();
    const { container } = render(<LiveCanvasV2 {...props} />);
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
    const { container } = render(<LiveCanvasV2 {...props} />);
    fireEvent.click(screen.getByText("固定"));
    expect(container.querySelector("[data-slot]")!.getAttribute("data-held")).toBe("true");
    fireEvent.click(screen.getByText("解除"));
    expect(container.querySelector("[data-slot]")!.getAttribute("data-held")).toBe("false");
  });

  it("ノートとスレッドの同一slotIdを二重描画しない", () => {
    const props = makeProps();
    const note = makeNote();
    props.notes = [note];
    props.threadCards = [{ type: "thread", slotId: note.slotId, pubkey: note.pubkey,
      created_at: note.created_at, score: 1, notes: [note], eventIds: new Set([note.eventId]) }];
    const { container } = render(<LiveCanvasV2 {...props} />);
    expect(container.querySelectorAll("[data-slot]")).toHaveLength(1);
    expect(screen.getByText("スレッド")).toBeDefined();
    expect(screen.queryByText("テスト投稿")).toBeNull();
  });
});
