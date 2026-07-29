import { describe, expect, it } from "vitest";
import {
  EMOJI_ALPHABET,
  emojiKeyToToken,
  generateToken,
  resolveJoinInput,
  slugToToken,
  tokenToEmojiKey,
  tokenToSlug,
} from "./room-token";

const MAX_TOKEN = 2 ** 42 - 1;

describe("generateToken", () => {
  it("produces a value within the 42-bit range", () => {
    for (let i = 0; i < 100; i++) {
      const token = generateToken();
      expect(Number.isInteger(token)).toBe(true);
      expect(token).toBeGreaterThanOrEqual(0);
      expect(token).toBeLessThanOrEqual(MAX_TOKEN);
    }
  });
});

describe("slug round-trip", () => {
  const boundaryValues = [0, 1, MAX_TOKEN];

  for (const token of boundaryValues) {
    it(`round-trips ${token}`, () => {
      const slug = tokenToSlug(token);
      expect(slug).toHaveLength(9);
      expect(slugToToken(slug)).toBe(token);
    });
  }

  it("round-trips 1000 random tokens", () => {
    for (let i = 0; i < 1000; i++) {
      const token = generateToken();
      expect(slugToToken(tokenToSlug(token))).toBe(token);
    }
  });

  it("rejects a token above the 42-bit range", () => {
    expect(() => tokenToSlug(MAX_TOKEN + 1)).toThrow(RangeError);
    expect(() => tokenToSlug(-1)).toThrow(RangeError);
  });

  it("never emits an excluded Crockford letter", () => {
    const excluded = /[ILOU]/;
    for (const token of [0, 1, MAX_TOKEN, generateToken(), generateToken()]) {
      expect(tokenToSlug(token)).not.toMatch(excluded);
    }
  });

  it("produces canonical uppercase output", () => {
    expect(tokenToSlug(0)).toBe(tokenToSlug(0).toUpperCase());
  });

  it("decodes leniently: lowercase, and I/L -> 1, O -> 0", () => {
    const slug = tokenToSlug(12345);
    expect(slugToToken(slug.toLowerCase())).toBe(12345);

    // Construct a slug containing characters that admit lenient aliases and
    // confirm the aliased and canonical forms decode identically.
    const withAliases = slug
      .replace(/1/g, "I")
      .replace(/0/g, "O");
    if (withAliases !== slug) {
      expect(slugToToken(withAliases)).toBe(12345);
    }
  });

  it("rejects the excluded letter U even though it is never emitted", () => {
    expect(slugToToken("00000000U")).toBeNull();
  });

  it("rejects wrong-length input", () => {
    expect(slugToToken("0000000")).toBeNull();
    expect(slugToToken("0000000000")).toBeNull();
  });

  it("rejects a slug whose value overflows 42 bits despite valid characters", () => {
    // "ZZZZZZZZZ" decodes to 2^45 - 1, far above the 42-bit ceiling.
    expect(slugToToken("ZZZZZZZZZ")).toBeNull();
  });
});

describe("emoji key round-trip", () => {
  const boundaryValues = [0, 1, MAX_TOKEN];

  it("has exactly 64 distinct entries", () => {
    expect(EMOJI_ALPHABET).toHaveLength(64);
    expect(new Set(EMOJI_ALPHABET).size).toBe(64);
  });

  for (const token of boundaryValues) {
    it(`round-trips ${token}`, () => {
      const key = tokenToEmojiKey(token);
      expect(Array.from(key)).toHaveLength(7);
      expect(emojiKeyToToken(key)).toBe(token);
    });
  }

  it("round-trips 1000 random tokens", () => {
    for (let i = 0; i < 1000; i++) {
      const token = generateToken();
      expect(emojiKeyToToken(tokenToEmojiKey(token))).toBe(token);
    }
  });

  it("rejects a token above the 42-bit range", () => {
    expect(() => tokenToEmojiKey(MAX_TOKEN + 1)).toThrow(RangeError);
  });

  it("rejects wrong-length or unknown-character input", () => {
    expect(emojiKeyToToken("🐶🐱🐭🐹🐰🦊")).toBeNull(); // 6 chars
    expect(emojiKeyToToken("🐶🐱🐭🐹🐰🦊🐻🐼")).toBeNull(); // 8 chars
    expect(emojiKeyToToken("🐶🐱🐭🐹🐰🦊👋")).toBeNull(); // 👋 not in alphabet
  });
});

describe("resolveJoinInput", () => {
  const token = 123456789;

  it("resolves a Room ID", () => {
    expect(resolveJoinInput(tokenToSlug(token))).toBe(token);
  });

  it("resolves an emoji key", () => {
    expect(resolveJoinInput(tokenToEmojiKey(token))).toBe(token);
  });

  it("resolves a shared room link", () => {
    const slug = tokenToSlug(token);
    expect(resolveJoinInput(`https://example.com/room/${slug}`)).toBe(token);
    expect(resolveJoinInput(`/room/${slug}`)).toBe(token);
  });

  it("tolerates surrounding whitespace", () => {
    expect(resolveJoinInput(`  ${tokenToSlug(token)}  `)).toBe(token);
  });

  it("returns null for invalid input", () => {
    expect(resolveJoinInput("not a valid room reference")).toBeNull();
    expect(resolveJoinInput("")).toBeNull();
    expect(resolveJoinInput("   ")).toBeNull();
  });
});
