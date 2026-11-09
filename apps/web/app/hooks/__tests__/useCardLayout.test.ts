// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { useCardLayout } from "../useCardLayout";
import { DEFAULT_CARD_HEIGHT, GAP } from "../../lib/constants";
import type { Card } from "../../lib/types";

afterEach(cleanup);

function note(slotId: string, score: number): Card {
  return { type: "note", slotId, score, pubkey: slotId, created_at: 0, eventId: `event-${slotId}`, content: "", tags: [] };
}

interface Props {
  cards: Card[];
  columns: number;
  held: ReadonlySet<string>;
}

function setup() {
  const props: Props = { cards: [note("a", 2), note("b", 1)], columns: 1, held: new Set() };
  return { props, ...renderHook(({ cards, columns, held }: Props) => useCardLayout(cards, columns, held), { initialProps: props }) };
}

describe("useCardLayoutの表示契約", () => {
  test("ホールド中は高さ変更で内部座標が動いても表示座標を維持し、解除すると追従する", () => {
    const { result, rerender, props } = setup();
    const heldProps = { ...props, held: new Set(["b"]) };
    rerender(heldProps);
    const frozen = result.current.displayLayout.get("b");
    act(() => result.current.handleHeightChange("a", 300));
    expect(result.current.cardLayout.get("b")).toEqual({ col: 0, y: 300 + GAP });
    expect(result.current.displayLayout.get("b")).toEqual(frozen);
    // フリーズ中の表示は内部グリッドと異なり、重なりを許容する。
    expect(frozen).toEqual({ col: 0, y: DEFAULT_CARD_HEIGHT + GAP });
    rerender({ ...heldProps, cards: [note("a", 1), note("b", 20)] });
    expect(result.current.displayLayout.get("b")).toEqual(frozen);
    rerender({ ...props, held: new Set() });
    expect(result.current.displayLayout).toEqual(result.current.cardLayout);
    expect(result.current.displayLayout.get("b")).toEqual({ col: 0, y: 300 + GAP });
  });

  test("列数変更はホールド座標を破棄し、新しい列内に再配置する", () => {
    const { result, rerender, props } = setup();
    const heldProps = { ...props, held: new Set(["b"]) };
    rerender(heldProps);
    const frozen = result.current.displayLayout.get("b");
    act(() => result.current.handleHeightChange("a", 300));
    rerender({ ...heldProps, columns: 2 });
    expect(result.current.displayLayout).toEqual(result.current.cardLayout);
    expect(result.current.displayLayout.get("b")).not.toEqual(frozen);
    expect(result.current.delayMap.size).toBe(0);
    rerender({ ...heldProps, columns: 1 });
    expect(result.current.displayLayout).toEqual(result.current.cardLayout);
    for (const p of result.current.displayLayout.values()) expect(p.col).toBe(0);
  });

  test("同じslotIdの下書きから投稿への置換は新規挿入せず、高さと配置を引き継ぐ", () => {
    const draft: Card = { type: "compose", slotId: "draft-slot", score: 3, pubkey: "me", created_at: 0 };
    const props: Props = { cards: [draft, note("a", 2)], columns: 1, held: new Set() };
    const { result, rerender } = renderHook(({ cards, columns, held }: Props) => useCardLayout(cards, columns, held), { initialProps: props });
    act(() => result.current.handleHeightChange("draft-slot", 200));
    const previous = new Map(result.current.cardLayout);
    rerender({ ...props, cards: [note("a", 2), note("draft-slot", 0)] });
    expect(result.current.cardLayout).toEqual(previous);
    expect(result.current.heightMap.get("draft-slot")).toBe(200);
    expect(result.current.delayMap.size).toBe(0);
    expect(result.current.cardLayout.has("event-draft-slot")).toBe(false);
  });

  test("削除と挿入が同時に起きても削除済みスロットを結果に残さない", () => {
    const { result, rerender, props } = setup();
    rerender({ ...props, cards: [note("new", 3), note("b", 1)] });
    expect(new Set(result.current.cardLayout.keys())).toEqual(new Set(["new", "b"]));
    expect(new Set(result.current.displayLayout.keys())).toEqual(new Set(["new", "b"]));
    expect(result.current.computeColumnHeight(0)).toBeGreaterThan(0);
  });

  test("同じ高さの再通知はレイアウトを変更しない", () => {
    const { result } = setup();
    act(() => result.current.handleHeightChange("a", 200));
    const grid = result.current.cardLayout;
    const heights = result.current.heightMap;
    act(() => result.current.handleHeightChange("a", 200));
    expect(result.current.cardLayout).toBe(grid);
    expect(result.current.heightMap).toBe(heights);
  });
});
