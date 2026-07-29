/**
 * Room token encoding (S1).
 *
 * One 42-bit random integer is the source of truth. `slug` (Crockford base32)
 * and `emojiKey` (a fixed 64-entry emoji alphabet) are reversible derivations
 * of that same integer. This module is isomorphic: both client and server
 * encode, decode, and resolve join input; only the server calls
 * `generateToken`.
 */

const TOKEN_BITS = 42n;
const MAX_TOKEN = (1n << TOKEN_BITS) - 1n; // 2^42 - 1

// Crockford base32: excludes I, L, O, U to avoid visual ambiguity.
const SLUG_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SLUG_LENGTH = 9; // 9 * 5 = 45 bits, covers the 42-bit token
const SLUG_GROUP_BITS = 5n;

// 64 hand-picked, single-codepoint emoji, chosen for pairwise visual
// distinctness rather than thematic grouping. Order is arbitrary but fixed:
// it defines the bit-index mapping and must never change.
export const EMOJI_ALPHABET = [
  "🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐨", "🐯",
  "🦁", "🐮", "🐷", "🐸", "🐵", "🐔", "🐧", "🐦", "🐤", "🦆",
  "🦅", "🦉", "🦇", "🐺", "🐗", "🐴", "🦄", "🐝", "🐛", "🦋",
  "🐌", "🐞", "🐜", "🐢", "🐍", "🦎", "🐙", "🦑", "🦀", "🐠",
  "🐟", "🐬", "🐳", "🐋", "🦈", "🐊", "🐆", "🐅", "🐘", "🦏",
  "🐪", "🐫", "🦒", "🦘", "🐃", "🐂", "🐄", "🐎", "🐖", "🐑",
  "🐐", "🦌", "🐕", "🐩",
] as const;

const EMOJI_KEY_LENGTH = 7; // 7 * 6 = 42 bits exactly
const EMOJI_GROUP_BITS = 6n;

function assertValidToken(token: number): asserts token is number {
  if (!Number.isInteger(token) || token < 0 || BigInt(token) > MAX_TOKEN) {
    throw new RangeError(`token out of 42-bit range: ${token}`);
  }
}

/** crypto-random 42-bit integer. Server-only: the client never generates one. */
export function generateToken(): number {
  const bytes = new Uint8Array(6); // 48 random bits, masked down to 42
  crypto.getRandomValues(bytes);
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  value &= MAX_TOKEN;
  return Number(value);
}

export function tokenToSlug(token: number): string {
  assertValidToken(token);
  let value = BigInt(token);
  let out = "";
  for (let group = SLUG_LENGTH - 1; group >= 0; group--) {
    const shift = BigInt(group) * SLUG_GROUP_BITS;
    const idx = Number((value >> shift) & 0x1fn);
    out += SLUG_ALPHABET[idx];
  }
  return out;
}

/**
 * Crockford's usual leniency: case-insensitive, I/L -> 1, O -> 0. `U` is not
 * remapped and is invalid, matching the alphabet's exclusion of it.
 */
function normalizeSlugChars(input: string): string {
  let out = "";
  for (const ch of input.toUpperCase()) {
    if (ch === "I" || ch === "L") out += "1";
    else if (ch === "O") out += "0";
    else out += ch;
  }
  return out;
}

export function slugToToken(slug: string): number | null {
  const normalized = normalizeSlugChars(slug.trim());
  if (normalized.length !== SLUG_LENGTH) return null;

  let value = 0n;
  for (const ch of normalized) {
    const idx = SLUG_ALPHABET.indexOf(ch);
    if (idx === -1) return null;
    value = (value << SLUG_GROUP_BITS) | BigInt(idx);
  }
  if (value > MAX_TOKEN) return null; // top padding bits must be zero
  return Number(value);
}

export function tokenToEmojiKey(token: number): string {
  assertValidToken(token);
  let value = BigInt(token);
  let out = "";
  for (let group = EMOJI_KEY_LENGTH - 1; group >= 0; group--) {
    const shift = BigInt(group) * EMOJI_GROUP_BITS;
    const idx = Number((value >> shift) & 0x3fn);
    out += EMOJI_ALPHABET[idx];
  }
  return out;
}

export function emojiKeyToToken(key: string): number | null {
  const emojis = Array.from(key.trim());
  if (emojis.length !== EMOJI_KEY_LENGTH) return null;

  let value = 0n;
  for (const emoji of emojis) {
    const idx = EMOJI_ALPHABET.indexOf(emoji as (typeof EMOJI_ALPHABET)[number]);
    if (idx === -1) return null;
    value = (value << EMOJI_GROUP_BITS) | BigInt(idx);
  }
  return Number(value);
}

const ROOM_LINK_PATTERN = /\/room\/([^/?#\s]+)/i;

/**
 * Distinguishes a Room ID from an emoji key by content and also accepts a
 * shared room link, so one input field can resolve all three join forms.
 */
export function resolveJoinInput(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const linkMatch = trimmed.match(ROOM_LINK_PATTERN);
  const candidate = linkMatch ? linkMatch[1] : trimmed;

  const fromSlug = slugToToken(candidate);
  if (fromSlug !== null) return fromSlug;

  return emojiKeyToToken(candidate);
}
