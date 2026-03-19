import { useState, useEffect, useMemo } from "react";
import { SimplePool } from "nostr-tools/pool";
import type { Event } from "nostr-tools/core";
import { parseNostrUri, extractEventId } from "../lib/nip19";
import type { NostrProfile } from "../lib/types";

/** Memory cache for quoted events */
const quotedEventCache = new Map<string, Event>();
const quotedProfileCache = new Map<string, NostrProfile>();

interface UseQuotedEventResult {
  event: Event | null;
  profile: NostrProfile | null;
  loading: boolean;
  error: string | null;
}

/**
 * Hook for fetching quoted events and their authors' profiles
 * @param uri - Nostr URI (nostr:nevent1..., nostr:note1..., etc.)
 * @param pool - SimplePool instance from useNostrRelay
 * @param relayUrls - Relay URLs from useNostrRelay
 * @returns Quoted event data, author profile, loading and error states
 */
export function useQuotedEvent(
  uri: string | null,
  pool: SimplePool | null,
  relayUrls: string[],
): UseQuotedEventResult {
  const [event, setEvent] = useState<Event | null>(null);
  const [profile, setProfile] = useState<NostrProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Parse URI and extract event ID
  const parsedUri = useMemo(() => {
    if (!uri) return null;
    return parseNostrUri(uri);
  }, [uri]);

  const eventId = useMemo(() => {
    if (!uri) return null;
    return extractEventId(uri);
  }, [uri]);

  // Extract relay hints from parsed URI
  const relayHints = useMemo(() => {
    if (!parsedUri) return [];
    if ("relays" in parsedUri && parsedUri.relays) {
      return parsedUri.relays;
    }
    return [];
  }, [parsedUri]);

  useEffect(() => {
    if (!eventId || !pool || relayUrls.length === 0) {
      setEvent(null);
      setProfile(null);
      setLoading(false);
      setError(null);
      return;
    }

    // Check cache first
    const cachedEvent = quotedEventCache.get(eventId);
    if (cachedEvent) {
      setEvent(cachedEvent);
      setLoading(false);
      setError(null);

      // Also check for cached profile
      const cachedProfile = quotedProfileCache.get(cachedEvent.pubkey);
      if (cachedProfile) {
        setProfile(cachedProfile);
        return;
      }

      // Fetch profile if event is cached but profile isn't
      fetchProfile(cachedEvent.pubkey, pool, relayUrls, setProfile);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    const fetchEvent = async () => {
      try {
        // Use relay hints if available, otherwise fallback to user's relay list
        const targetRelays = relayHints.length > 0 ? relayHints : relayUrls;

        // Subscribe to the specific event
        const sub = pool.subscribeMany(
          targetRelays,
          [{ ids: [eventId] }],
          {
            onevent: (receivedEvent: Event) => {
              if (cancelled) return;

              // Cache the event
              quotedEventCache.set(eventId, receivedEvent);
              setEvent(receivedEvent);

              // Fetch author profile
              fetchProfile(receivedEvent.pubkey, pool, relayUrls, setProfile);
            },
            oneose: () => {
              if (cancelled) return;
              setLoading(false);
            },
          },
        );

        // Timeout after 5 seconds
        setTimeout(() => {
          if (cancelled) return;
          sub.close();
          if (!quotedEventCache.has(eventId)) {
            setError("引用先のノートが見つかりませんでした");
            setLoading(false);
          }
        }, 5000);

        return () => {
          cancelled = true;
          sub.close();
        };
      } catch (err) {
        if (!cancelled) {
          console.error("Error fetching quoted event:", err);
          setError("引用先のノートの取得に失敗しました");
          setLoading(false);
        }
      }
    };

    fetchEvent();

    return () => {
      cancelled = true;
    };
  }, [eventId, pool, relayUrls, relayHints]);

  return { event, profile, loading, error };
}

/**
 * Helper function to fetch profile for a given pubkey
 */
function fetchProfile(
  pubkey: string,
  pool: SimplePool,
  relayUrls: string[],
  setProfile: (profile: NostrProfile | null) => void,
) {
  // Check cache first
  const cached = quotedProfileCache.get(pubkey);
  if (cached) {
    setProfile(cached);
    return;
  }

  // Subscribe to kind 0 events for this pubkey
  const profileSub = pool.subscribeMany(
    relayUrls,
    [{ kinds: [0], authors: [pubkey] }],
    {
      onevent: (profileEvent: Event) => {
        try {
          const content = JSON.parse(profileEvent.content);
          const profileData: NostrProfile = {
            pubkey,
            name: content.name || "",
            display_name: content.display_name || content.name || "",
            about: content.about || "",
            picture: content.picture || "",
            banner: content.banner || "",
            website: content.website || "",
            lud06: content.lud06 || "",
            lud16: content.lud16 || "",
            nip05: content.nip05 || "",
          };

          // Cache the profile
          quotedProfileCache.set(pubkey, profileData);
          setProfile(profileData);
        } catch (err) {
          console.error("Error parsing profile event:", err);
        }
      },
      oneose: () => {
        // Close the profile subscription after EOSE
        setTimeout(() => profileSub.close(), 100);
      },
    },
  );

  // Timeout for profile fetch
  setTimeout(() => {
    profileSub.close();
  }, 3000);
}