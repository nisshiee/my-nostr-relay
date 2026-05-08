import { useEffect, useReducer } from "react";
import type { Event } from "nostr-tools/core";

interface UseHashtagNotesParams {
  tag: string | null;
  enabled: boolean;
  fetchHashtagNotes: (tag: string) => Promise<Event[]>;
}

interface UseHashtagNotesResult {
  notes: Event[];
  isLoading: boolean;
  error: string | null;
}

interface UseHashtagNotesState {
  requestedTag: string | null;
  notes: Event[];
  isLoading: boolean;
  error: string | null;
}

type UseHashtagNotesAction =
  | { type: "start"; tag: string }
  | { type: "success"; tag: string; notes: Event[] }
  | { type: "error"; tag: string; error: string };

function reducer(
  state: UseHashtagNotesState,
  action: UseHashtagNotesAction,
): UseHashtagNotesState {
  switch (action.type) {
    case "start":
      return { requestedTag: action.tag, notes: [], isLoading: true, error: null };
    case "success":
      if (state.requestedTag !== action.tag) return state;
      return { requestedTag: action.tag, notes: action.notes, isLoading: false, error: null };
    case "error":
      if (state.requestedTag !== action.tag) return state;
      return { requestedTag: action.tag, notes: [], isLoading: false, error: action.error };
    default:
      return state;
  }
}

export function useHashtagNotes({
  tag,
  enabled,
  fetchHashtagNotes,
}: UseHashtagNotesParams): UseHashtagNotesResult {
  const [state, dispatch] = useReducer(reducer, {
    requestedTag: null,
    notes: [],
    isLoading: false,
    error: null,
  });

  useEffect(() => {
    if (!enabled || !tag) return;

    let cancelled = false;
    dispatch({ type: "start", tag });

    void fetchHashtagNotes(tag)
      .then((events) => {
        if (cancelled) return;
        dispatch({ type: "success", tag, notes: events });
      })
      .catch((err) => {
        if (cancelled) return;
        dispatch({
          type: "error",
          tag,
          error: err instanceof Error ? err.message : "ハッシュタグの取得に失敗しました",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, tag, fetchHashtagNotes]);

  if (!enabled || !tag) {
    return { notes: [], isLoading: false, error: null };
  }

  if (state.requestedTag !== tag) {
    return { notes: [], isLoading: true, error: null };
  }

  return state;
}
