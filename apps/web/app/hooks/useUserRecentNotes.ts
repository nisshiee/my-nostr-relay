import { useEffect, useReducer } from "react";
import type { Event } from "nostr-tools/core";

interface UseUserRecentNotesParams {
  pubkey: string | null;
  enabled: boolean;
  fetchUserRecentNotes: (pubkey: string) => Promise<Event[]>;
}

interface UseUserRecentNotesResult {
  notes: Event[];
  isLoading: boolean;
  error: string | null;
}

interface UseUserRecentNotesState {
  requestedPubkey: string | null;
  notes: Event[];
  isLoading: boolean;
  error: string | null;
}

type UseUserRecentNotesAction =
  | { type: "start"; pubkey: string }
  | { type: "success"; pubkey: string; notes: Event[] }
  | { type: "error"; pubkey: string; error: string };

function useUserRecentNotesReducer(
  state: UseUserRecentNotesState,
  action: UseUserRecentNotesAction,
): UseUserRecentNotesState {
  switch (action.type) {
    case "start":
      return {
        requestedPubkey: action.pubkey,
        notes: [],
        isLoading: true,
        error: null,
      };
    case "success":
      if (state.requestedPubkey !== action.pubkey) {
        return state;
      }

      return {
        requestedPubkey: action.pubkey,
        notes: action.notes,
        isLoading: false,
        error: null,
      };
    case "error":
      if (state.requestedPubkey !== action.pubkey) {
        return state;
      }

      return {
        requestedPubkey: action.pubkey,
        notes: [],
        isLoading: false,
        error: action.error,
      };
    default:
      return state;
  }
}

export function useUserRecentNotes({
  pubkey,
  enabled,
  fetchUserRecentNotes,
}: UseUserRecentNotesParams): UseUserRecentNotesResult {
  const [state, dispatch] = useReducer(useUserRecentNotesReducer, {
    requestedPubkey: null,
    notes: [],
    isLoading: false,
    error: null,
  });

  useEffect(() => {
    if (!enabled || !pubkey) {
      return;
    }

    let cancelled = false;
    dispatch({ type: "start", pubkey });

    void fetchUserRecentNotes(pubkey)
      .then((events) => {
        if (cancelled) return;
        dispatch({ type: "success", pubkey, notes: events });
      })
      .catch((err) => {
        if (cancelled) return;
        dispatch({
          type: "error",
          pubkey,
          error: err instanceof Error ? err.message : "ノートの取得に失敗しました",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, pubkey, fetchUserRecentNotes]);

  if (!enabled || !pubkey) {
    return { notes: [], isLoading: false, error: null };
  }

  if (state.requestedPubkey !== pubkey) {
    return { notes: [], isLoading: true, error: null };
  }

  return state;
}
