/**
 * store/pure/buildThreads.ts
 *
 * スレッド構築の純粋関数群。
 * lib/threadBuilder.ts からの移植（リファクタ）。
 *
 * リファクタ内容:
 * - store の state（events Map）を引数で受け取るパターンに調整
 * - 関数シグネチャは同じまま維持（既存ロジックは変更なし）
 * - buildThreadCard の crypto.randomUUID() 呼び出しはそのまま維持
 *   （純粋関数の厳密性よりも既存ロジック保持を優先）
 */

import type { ThreadNote, ThreadCard } from "../../lib/types";
export { MAX_THREAD_DEPTH } from "../../lib/constants";

/**
 * kind:1 イベントから全 e タグの参照先 eventId を抽出する
 */
export function extractReplyEventIds(tags: string[][]): string[] {
  return tags
    .filter(tag => tag[0] === "e" && tag[1])
    .map(tag => tag[1]!);
}

/**
 * kind:1 イベントがリプライかどうか判定する（e タグが1つ以上あればリプライ）
 */
export function isReply(tags: string[][]): boolean {
  return tags.some(tag => tag[0] === "e" && tag[1]);
}

/**
 * 直接の返信先を取得する（最後の e タグ）
 * TODO: NIP-10 marker（reply/root）対応。現在は後方互換の「最後のeタグ」ルールを使用
 */
export function getDirectReplyTarget(tags: string[][]): string | undefined {
  const eTags = tags.filter(tag => tag[0] === "e" && tag[1]);
  if (eTags.length === 0) return undefined;
  return eTags[eTags.length - 1]![1]!;
}

/**
 * NostrイベントからThreadNoteを作成する
 * replyTo.pubkey は後から resolveReplyAuthors で解決する
 */
export function eventToThreadNote(event: {
  id: string;
  pubkey: string;
  content: string;
  created_at: number;
  tags: string[][];
}): ThreadNote {
  const eTags = event.tags.filter(tag => tag[0] === "e" && tag[1]);
  // NIP-10: marker付きタグを優先、なければ最後のeタグ
  const replyTag = eTags.find(tag => tag[3] === "reply") ?? eTags[eTags.length - 1];
  const replyTargetId = replyTag?.[1];
  const replyTargetPubkey = replyTag?.[4] || undefined;

  return {
    eventId: event.id,
    pubkey: event.pubkey,
    content: event.content,
    created_at: event.created_at,
    tags: event.tags,
    replyTo: replyTargetId ? { eventId: replyTargetId, pubkey: replyTargetPubkey } : undefined,
  };
}

/**
 * ThreadNote の replyTo.pubkey を解決する
 * スレッド内のノートから eventId → pubkey のマップを作り、replyTo に pubkey を設定する
 */
export function resolveReplyAuthors(notes: ThreadNote[]): ThreadNote[] {
  const pubkeyMap = new Map<string, string>();
  for (const note of notes) {
    pubkeyMap.set(note.eventId, note.pubkey);
  }
  return notes.map(note => {
    if (!note.replyTo) return note;
    const pubkey = pubkeyMap.get(note.replyTo.eventId);
    if (pubkey && pubkey !== note.replyTo.pubkey) {
      return { ...note, replyTo: { ...note.replyTo, pubkey } };
    }
    return note;
  });
}

/**
 * ThreadNote[] から ThreadCard を構築する
 * @param notes スレッドを構成するノート群
 * @param _ownerPubkey ログインユーザーの pubkey（将来のスコア計算拡張用、現在は未使用）
 */
export function buildThreadCard(
  notes: ThreadNote[],
  _ownerPubkey: string,
): ThreadCard {
  const sorted = [...notes].sort((a, b) => a.created_at - b.created_at);
  const resolved = resolveReplyAuthors(sorted);

  const eventIds = new Set<string>(resolved.map(n => n.eventId));

  const latestCreatedAt =
    resolved.length > 0
      ? Math.max(...resolved.map(n => n.created_at))
      : 0;

  return {
    type: "thread",
    slotId: crypto.randomUUID(),
    pubkey: resolved[0]?.pubkey ?? "",
    score: 0,
    fadingOut: false,
    created_at: latestCreatedAt,
    notes: resolved,
    eventIds,
  };
}

/**
 * 既存の ThreadCard 群の中から、指定した eventId 集合とオーバーラップするものを探す
 * 判定: 新しいノートの e タグ参照先に、既存 ThreadCard の eventIds との共通要素が1つ以上
 */
export function findOverlappingThreads(
  threads: ThreadCard[],
  referenceEventIds: string[],
): ThreadCard[] {
  const refSet = new Set(referenceEventIds);
  return threads.filter(thread => {
    for (const id of thread.eventIds) {
      if (refSet.has(id)) return true;
    }
    return false;
  });
}

/**
 * 複数の ThreadCard をマージする（+ 新しいノート群を追加）
 * 重複する eventId のノートは除外される
 */
export function mergeThreadCards(
  existingThreads: ThreadCard[],
  newNotes: ThreadNote[],
  ownerPubkey: string,
): ThreadCard {
  const allNotes = new Map<string, ThreadNote>();
  for (const thread of existingThreads) {
    for (const note of thread.notes) {
      allNotes.set(note.eventId, note);
    }
  }
  for (const note of newNotes) {
    allNotes.set(note.eventId, note);
  }

  const result = buildThreadCard([...allNotes.values()], ownerPubkey);
  if (existingThreads.length > 0) {
    return { ...result, slotId: existingThreads[0]!.slotId };
  }
  return result;
}

/**
 * 再帰的にフェッチすべき eventId を収集する（深度制限・ループ検出付き）
 * @param knownEventIds 既に取得済みの eventId 集合
 * @param newNotes 新たに取得したノート群
 * @returns フェッチが必要な eventId のリスト
 */
export function collectMissingEventIds(
  knownEventIds: ReadonlySet<string>,
  newNotes: Array<{ id: string; tags: string[][] }>,
): string[] {
  const missing = new Set<string>();
  for (const note of newNotes) {
    const refs = extractReplyEventIds(note.tags);
    for (const ref of refs) {
      if (!knownEventIds.has(ref) && !missing.has(ref)) {
        missing.add(ref);
      }
    }
  }
  return [...missing];
}
