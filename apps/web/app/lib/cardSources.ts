import type { CardScoreSource } from "./types";

/** 表示形式に依存しない、保持中の投稿とカードの対応。 */
export interface SourceBackedCard<T> {
  card: T;
  sourceIds: Iterable<string>;
}

/**
 * 保持済み投稿を唯一の寿命・採点根拠にする。
 * 単独でも集約でも、根拠がなくなれば同じ経路で除去する。
 */
export function reconcileCardSources<T, S extends CardScoreSource>(
  candidates: readonly SourceBackedCard<T>[],
  retainedSources: ReadonlyMap<string, S>,
): (T & { scoreSources: S[] })[] {
  return candidates.flatMap(({ card, sourceIds }) => {
    const scoreSources = [...new Set(sourceIds)].flatMap(id => {
      const source = retainedSources.get(id);
      return source ? [source] : [];
    });
    return scoreSources.length ? [{ ...card, scoreSources }] : [];
  });
}
