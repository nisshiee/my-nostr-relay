# Canvas Store リファクタリング設計

## 背景

apps/web の現実装は、各 React hook が独自に nostr-tools の pool を直接呼んで、
独自のキャッシュ・重複排除・副作用管理を行っている。結果として：

- 同じ「eventId → Event を取得する」ロジックが3箇所に散在（useNostrNotes, useThreadCards, useQuotedEvent）
- プロフィール取得が統一されておらず、useQuotedEvent は useNostrProfiles を無視して自前キャッシュ
- スレッド祖先のフォロー外ユーザーのプロフィールが取得されない穴
- hook 間の引数が多い（useNostrNotes は9引数）

## ゴール

zustand を使って1つの CanvasStore に統合する。

### 設計原則

1. **reduce(state, event) → state と render(state) → VDOM の構造を維持する**
   - 各アクション内の `set` コールバックに相当する state 更新は純粋なロジック
   - 共通ロジック（rebuildCards, recalcLayout, recalcScores）は純粋関数として抽出してテスト可能にする

2. **DomainState にレイアウトまで含む**
   - このアプリのドメインは「Live Canvas」であり、カード配置・スコア・fadingOut はドメインの一部
   - View（React/DOM）には framer-motion のアニメーション管理だけ残る

3. **pool は store 内部に隠蔽**
   - Component は pool, relayUrls を知らない
   - selector 経由で必要なデータだけ取得する

4. **subscribe 連鎖は C パターン（アクション内で次を呼ぶ）**
   - connect → subscribeFeed → (onEose) → subscribeReactions
   - コメントで連鎖フローを明示する

## Store 構造

### State

```typescript
interface CanvasStoreState {
  // 接続
  phase: "connecting" | "loading" | "ready" | "error";
  relayUrls: string[];
  followPubkeys: string[];
  pubkey: string | null;

  // Nostr データキャッシュ
  events: Map<string, Event>;
  profiles: Map<string, NostrProfile>;
  reactions: Map<string, Map<string, ReactionEntry>>;
  repostMeta: Map<string, RepostMeta>;  // eventId → リポスト情報

  // Canvas ドメイン
  timelineIds: string[];                 // タイムラインに並ぶ eventId
  threadGroups: Map<string, string[]>;   // rootEventId → [eventId, ...]
  cards: Card[];                         // 最終的なカード配列（ソート済み）
  layout: Map<string, Placement>;        // slotId → 配置位置
  heights: Map<string, number>;          // slotId → DOM 測定高さ
  delays: Map<string, number>;           // slotId → アニメーション遅延
  columnCount: number;
  holdSet: Set<string>;
}
```

### Actions

```typescript
interface CanvasStoreActions {
  // Nostr 接続・購読（副作用あり）
  connect: (pubkey: string) => Promise<void>;
  subscribeFeed: () => Unsubscribe;
  subscribeReactions: (eventIds: string[]) => Unsubscribe;
  resolveRepost: (repostEvent: Event) => Promise<void>;
  resolveReposts: (repostEvents: Event[]) => Promise<void>;
  fetchAncestors: (eventIds: string[]) => Promise<void>;
  ensureProfiles: (pubkeys: string[]) => Promise<void>;
  fetchQuoted: (eventId: string, relayHints?: string[]) => Promise<Event | null>;
  publishEvent: (event: Event, slotId?: string) => Promise<void>;
  sendReaction: (targetEventId: string, targetPubkey: string, emoji: string, imageUrl?: string) => Promise<void>;

  // Canvas 操作（同期、set のみ）
  setHeight: (slotId: string, height: number) => void;
  setColumnCount: (count: number) => void;
  holdCard: (slotId: string) => void;
  releaseCard: (slotId: string) => void;
  tick: (now: number) => void;

  // クリーンアップ
  disconnect: () => void;
}
```

### 初期ロードの連鎖フロー

```
connect(pubkey)
  → pool 作成、kind:10002/3 取得
  → relayUrls, followPubkeys 確定
  → subscribeFeed() を呼ぶ

subscribeFeed()
  → kind:1/6 subscribe 開始
  → onEose: 初期ノート確定
    → resolveReposts(kind6Events) で元ノート一括取得
    → subscribeReactions(eventIds) を呼ぶ

subscribeReactions(eventIds)
  → kind:7 subscribe 開始
  → 定期的に re-subscribe（ポーリング）
```

### Selector 例

```typescript
// LiveCanvas が使う
useCanvasStore(s => s.cards)
useCanvasStore(s => s.layout)

// NoteCard が使う
useCanvasStore(s => s.profiles.get(pubkey))
useCanvasStore(s => s.reactions.get(eventId))

// CanvasHeader が使う
useCanvasStore(s => s.phase)
```

## ファイル構造

store の実装が巨大になるため、以下のように分割する：

```
app/
  store/
    index.ts                 — store 作成、全 slice を結合
    types.ts                 — State, Action, 内部型定義
    slices/
      connection.ts          — connect, disconnect, pool/relay 管理
      feed.ts                — subscribeFeed, resolveRepost(s), リアルタイム kind:1 処理
      threads.ts             — fetchAncestors, スレッドグルーピング
      profiles.ts            — ensureProfiles, kind:0 処理
      reactions.ts           — subscribeReactions, kind:7 処理, re-subscribe
      quotes.ts              — fetchQuoted（引用先イベント+プロフィール取得）
      publish.ts             — publishEvent, sendReaction
      canvas.ts              — setHeight, setColumnCount, holdCard, releaseCard, tick
    pure/
      buildCards.ts           — events + timelineIds + repostMeta → Card[]（純粋関数）
      buildThreads.ts         — リプライ検出、スレッドグルーピング（純粋関数）
      layoutEngine.ts         — 既存 layoutEngine の移植（純粋関数）
      scoring.ts              — スコア計算（既存 scoring.ts の移植）
    selectors.ts             — useProfile(pubkey), useReactionsFor(eventId) 等のカスタム selector
  components/
    LiveCanvas.tsx           — store の cards/layout を購読、framer-motion で描画
    NoteCard.tsx             — store の profile/reactions を selector で取得
    ThreadCard.tsx           — 同上
    QuoteNode.tsx            — store の fetchQuoted を使用（useQuotedEvent hook は廃止）
    ...
```

## 移行に伴って削除されるファイル

- hooks/useNostrRelay.ts（オーケストレーター hook → store で代替）
- hooks/useNostrConnection.ts（→ store/slices/connection.ts）
- hooks/useNostrProfiles.ts（→ store/slices/profiles.ts）
- hooks/useNostrNotes.ts（→ store/slices/feed.ts）
- hooks/useNostrReactions.ts（→ store/slices/reactions.ts）
- hooks/useQuotedEvent.ts（→ store/slices/quotes.ts）
- hooks/useThreadCards.ts（→ store/slices/threads.ts + store/pure/buildThreads.ts）
- hooks/useCardLayout.ts（→ store/slices/canvas.ts + store/pure/layoutEngine.ts）

## 移行に伴って残る hooks

- hooks/useDraftNotes.ts — 下書き管理は Component ローカルのままでよい（store に入れるか後日検討）

## 既存の純粋関数の移行

| 現在 | 移行先 |
|------|--------|
| lib/scoring.ts | store/pure/scoring.ts（そのまま） |
| lib/layoutEngine.ts | store/pure/layoutEngine.ts（そのまま） |
| lib/threadBuilder.ts | store/pure/buildThreads.ts（リファクタ） |
| lib/createNoteCard.ts | store/pure/buildCards.ts（リファクタ） |
| lib/contentParser.ts | 変更なし（Component 側で使用） |
| lib/nip19.ts | 変更なし |
| lib/constants.ts | 変更なし |
| lib/types.ts | store/types.ts に統合 |

## 注意事項

- zustand の `redux` middleware は使わない（dispatch/DomainEvent パターンを採用しないため）
- 各アクション内で `set`/`get` を使って直接 state を更新する zustand ネイティブスタイル
- state 更新で呼ぶ共通ロジック（pure/ 以下）は純粋関数として抽出しテスト可能にする
- `_pool`, `_inflight` 等の内部変数は store state に含めるが、selector からは使わない規約
