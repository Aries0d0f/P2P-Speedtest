import { describe, expect, it } from "vitest";
import { bytesToUuid, uuidToBytes } from "./uuid-bytes";

describe("uuid <-> bytes round-trip", () => {
  it("round-trips a v4 uuid", () => {
    for (let i = 0; i < 100; i++) {
      const uuid = crypto.randomUUID();
      expect(bytesToUuid(uuidToBytes(uuid))).toBe(uuid);
    }
  });

  it("produces 16 bytes in network order", () => {
    const uuid = "01234567-89ab-cdef-0123-456789abcdef";
    const bytes = uuidToBytes(uuid);
    expect(bytes).toHaveLength(16);
    expect(Array.from(bytes)).toEqual([
      0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67,
      0x89, 0xab, 0xcd, 0xef,
    ]);
  });

  it("produces canonical lowercase text regardless of input case", () => {
    const upper = "01234567-89AB-CDEF-0123-456789ABCDEF";
    expect(bytesToUuid(uuidToBytes(upper))).toBe(
      "01234567-89ab-cdef-0123-456789abcdef",
    );
  });

  it("rejects malformed uuid text", () => {
    expect(() => uuidToBytes("not-a-uuid")).toThrow(RangeError);
    expect(() => uuidToBytes("01234567-89ab-cdef-0123-456789abcde")).toThrow(
      RangeError,
    );
  });

  it("rejects a byte array of the wrong length", () => {
    expect(() => bytesToUuid(new Uint8Array(15))).toThrow(RangeError);
    expect(() => bytesToUuid(new Uint8Array(17))).toThrow(RangeError);
  });
});
