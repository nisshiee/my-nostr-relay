import type { Event } from "nostr-tools/core";
import type { Filter } from "nostr-tools/filter";
import type { SimplePool } from "nostr-tools/pool";
import type { SubCloser } from "nostr-tools/abstract-pool";

export const TIMELINE_RECONNECT_OVERLAP_SECONDS = 10;
export const TIMELINE_RETRY_LIMIT = 5;
export const TIMELINE_RETRY_BASE_MS = 1_000;
export const TIMELINE_RETRY_MAX_MS = 30_000;

const MAX_REMEMBERED_EVENT_IDS = 10_000;

type CloseReason = { url: string; reason: string };

export interface TimelineSubscriptionParams {
  onevent(event: Event): void;
  oneose?(): void | Promise<void>;
  onterminalclose?(): void;
}

export interface TimelineSubscriptionOptions {
  retryLimit?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  reconnectOverlapSeconds?: number;
  random?: () => number;
}

type CloseCategory = "transient" | "auth" | "rate-limit" | "blocked" | "invalid" | "other";

function classifyCloseReason(reason: string): CloseCategory {
  const normalized = reason.toLowerCase();
  if (normalized.includes("auth-required") || normalized.includes("auth required")) return "auth";
  if (normalized.includes("rate-limit") || normalized.includes("rate limit") || normalized.includes("too many")) return "rate-limit";
  if (normalized.includes("blocked") || normalized.includes("restricted") || normalized.includes("banned")) return "blocked";
  if (normalized.includes("invalid") || normalized.includes("unsupported") || normalized.includes("malformed")) return "invalid";
  if (
    normalized.includes("connection")
    || normalized.includes("websocket")
    || normalized.includes("timeout")
    || normalized.includes("temporarily unavailable")
    || normalized.includes("server unavailable")
  ) return "transient";
  return "other";
}

function reconnectFilter(
  baseFilter: Filter,
  latestCreatedAt: number | undefined,
  overlapSeconds: number,
): Filter {
  if (latestCreatedAt === undefined) return { ...baseFilter };
  const now = Math.floor(Date.now() / 1000);
  const boundedWatermark = Math.min(latestCreatedAt, now);
  const overlapSince = Math.max(0, boundedWatermark - overlapSeconds);
  return {
    ...baseFilter,
    since: Math.max(baseFilter.since ?? 0, overlapSince),
  };
}

/**
 * タイムライン購読をアプリ境界で再作成する。
 *
 * SDK のソケット再接続は受信時刻の最大値 + 1 を since にするため、この購読に渡す
 * pool は enableReconnect: false で作る。ここで未来時刻を watermark から除外し、同秒遅配を
 * overlap で拾い直し、event id で重複を除く。
 */
export function subscribeTimeline(
  pool: SimplePool,
  relayUrls: string[],
  baseFilter: Filter,
  params: TimelineSubscriptionParams,
  options: TimelineSubscriptionOptions = {},
): SubCloser {
  const retryLimit = options.retryLimit ?? TIMELINE_RETRY_LIMIT;
  const retryBaseMs = options.retryBaseMs ?? TIMELINE_RETRY_BASE_MS;
  const retryMaxMs = options.retryMaxMs ?? TIMELINE_RETRY_MAX_MS;
  const overlapSeconds = options.reconnectOverlapSeconds ?? TIMELINE_RECONNECT_OVERLAP_SECONDS;
  const random = options.random ?? Math.random;

  let cancelled = false;
  let initialEoseNotified = false;
  const rememberedIds = new Set<string>();
  const rememberedOrder: string[] = [];
  const relayStates = relayUrls.map((url) => ({
    url,
    current: null as SubCloser | null,
    retryTimer: null as ReturnType<typeof setTimeout> | null,
    retryCount: 0,
    latestSafeCreatedAt: undefined as number | undefined,
    eosed: false,
    terminal: false,
  }));

  const remember = (id: string): boolean => {
    if (rememberedIds.has(id)) return false;
    rememberedIds.add(id);
    rememberedOrder.push(id);
    if (rememberedOrder.length > MAX_REMEMBERED_EVENT_IDS) {
      const expired = rememberedOrder.shift();
      if (expired) rememberedIds.delete(expired);
    }
    return true;
  };

  const notifyInitialEose = () => {
    if (
      cancelled
      || initialEoseNotified
      || !relayStates.every((state) => state.eosed || state.terminal)
    ) return undefined;
    initialEoseNotified = true;
    return params.oneose?.();
  };

  const notifyTerminalClose = () => {
    if (relayStates.every((state) => state.terminal)) params.onterminalclose?.();
  };

  const start = (state: typeof relayStates[number]) => {
    if (cancelled || state.terminal) return;
    state.current = pool.subscribeMany(
      [state.url],
      reconnectFilter(baseFilter, state.latestSafeCreatedAt, overlapSeconds),
      {
        onevent(event) {
          if (cancelled) return;
          const receivedAt = Math.floor(Date.now() / 1000);
          // Future-dated events must not skip an unreceived historical range.
          if (event.created_at <= receivedAt) {
            state.latestSafeCreatedAt = Math.max(
              state.latestSafeCreatedAt ?? event.created_at,
              event.created_at,
            );
          }
          // Each relay made progress, even when another relay delivered this ID first.
          state.retryCount = 0;
          if (!remember(event.id)) return;
          params.onevent(event);
        },
        oneose() {
          if (cancelled) return;
          state.eosed = true;
          return notifyInitialEose();
        },
        onclose(reasons: CloseReason[]) {
          if (cancelled) return;
          const category = classifyCloseReason(reasons[0]?.reason ?? "");
          if (!initialEoseNotified) state.eosed = false;

          if (category !== "transient" || state.retryCount >= retryLimit) {
            state.terminal = true;
            console.warn("[timeline] 購読を終了しました", {
              reasonCategory: category,
              retryCount: state.retryCount,
            });
            notifyInitialEose();
            notifyTerminalClose();
            return;
          }

          const exponential = Math.min(retryMaxMs, retryBaseMs * (2 ** state.retryCount));
          const jittered = Math.round(exponential * (0.8 + random() * 0.4));
          state.retryCount += 1;
          console.warn("[timeline] 購読を再試行します", {
            reasonCategory: category,
            retryCount: state.retryCount,
            delayMs: jittered,
          });
          state.retryTimer = setTimeout(() => start(state), jittered);
        },
      },
    );
  };

  for (const state of relayStates) start(state);

  return {
    close(reason = "timeline subscription cleanup") {
      if (cancelled) return;
      cancelled = true;
      for (const state of relayStates) {
        if (state.retryTimer) clearTimeout(state.retryTimer);
        state.retryTimer = null;
        state.current?.close(reason);
        state.current = null;
      }
    },
  };
}
