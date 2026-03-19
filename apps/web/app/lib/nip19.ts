/**
 * NIP-19 Nostr Entity Decoder
 * Decodes Nostr URIs (nevent1, note1, naddr1) into structured data
 */

import { decode } from "nostr-tools/nip19";

/** Decoded nevent data */
export interface DecodedNevent {
  type: "nevent";
  eventId: string;
  relays?: string[];
  pubkey?: string;
}

/** Decoded note data */
export interface DecodedNote {
  type: "note";
  eventId: string;
}

/** Decoded naddr data */
export interface DecodedNaddr {
  type: "naddr";
  kind: number;
  pubkey: string;
  d: string;
  relays?: string[];
}

/** Union type for all decoded results */
export type DecodedNostr = DecodedNevent | DecodedNote | DecodedNaddr;

/**
 * Decode nevent1... string into structured data
 * @param nevent - The nevent1... string (with or without nostr: prefix)
 * @returns Decoded nevent data or null if invalid
 */
export function decodeNevent(nevent: string): DecodedNevent | null {
  try {
    // Remove nostr: prefix if present
    const cleanNevent = nevent.replace(/^nostr:/, "");
    
    if (!cleanNevent.startsWith("nevent1")) {
      return null;
    }

    const decoded = decode(cleanNevent);
    
    if (decoded.type !== "nevent") {
      return null;
    }

    return {
      type: "nevent",
      eventId: decoded.data.id,
      relays: decoded.data.relays?.length ? decoded.data.relays : undefined,
      pubkey: decoded.data.author || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Decode note1... string into structured data
 * @param note - The note1... string (with or without nostr: prefix)
 * @returns Decoded note data or null if invalid
 */
export function decodeNote(note: string): DecodedNote | null {
  try {
    // Remove nostr: prefix if present
    const cleanNote = note.replace(/^nostr:/, "");
    
    if (!cleanNote.startsWith("note1")) {
      return null;
    }

    const decoded = decode(cleanNote);
    
    if (decoded.type !== "note") {
      return null;
    }

    return {
      type: "note",
      eventId: decoded.data,
    };
  } catch {
    return null;
  }
}

/**
 * Decode naddr1... string into structured data
 * @param naddr - The naddr1... string (with or without nostr: prefix)
 * @returns Decoded naddr data or null if invalid
 */
export function decodeNaddr(naddr: string): DecodedNaddr | null {
  try {
    // Remove nostr: prefix if present
    const cleanNaddr = naddr.replace(/^nostr:/, "");
    
    if (!cleanNaddr.startsWith("naddr1")) {
      return null;
    }

    const decoded = decode(cleanNaddr);
    
    if (decoded.type !== "naddr") {
      return null;
    }

    return {
      type: "naddr",
      kind: decoded.data.kind,
      pubkey: decoded.data.pubkey,
      d: decoded.data.identifier,
      relays: decoded.data.relays?.length ? decoded.data.relays : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Parse any Nostr URI into structured data
 * @param uri - The nostr:xxx URI or raw bech32 string
 * @returns Decoded Nostr entity or null if invalid
 */
export function parseNostrUri(uri: string): DecodedNostr | null {
  // Remove nostr: prefix for processing
  const cleanUri = uri.replace(/^nostr:/, "");
  
  if (cleanUri.startsWith("nevent1")) {
    return decodeNevent(uri);
  } else if (cleanUri.startsWith("note1")) {
    return decodeNote(uri);
  } else if (cleanUri.startsWith("naddr1")) {
    return decodeNaddr(uri);
  }
  
  return null;
}

/**
 * Extract event ID from any Nostr URI
 * @param uri - The nostr:xxx URI or raw bech32 string
 * @returns Event ID or null if not applicable or invalid
 */
export function extractEventId(uri: string): string | null {
  const decoded = parseNostrUri(uri);
  
  if (!decoded) return null;
  
  if (decoded.type === "nevent" || decoded.type === "note") {
    return decoded.eventId;
  }
  
  // naddr doesn't have a direct event ID
  return null;
}