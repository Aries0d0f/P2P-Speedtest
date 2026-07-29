import { describe, expect, it } from "vitest";
import { canonicalize, computeResultHash } from "./result-hash";

describe("canonicalize (RFC 8785 JCS)", () => {
  it("sorts object keys by UTF-16 code unit", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("produces byte-identical output regardless of key insertion order", () => {
    const a = { speed: 94500000, latency: 38.2, from: "x", to: "y" };
    const b = { to: "y", from: "x", latency: 38.2, speed: 94500000 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it("prints a large integer speed with no exponent, decimal point, or plus sign", () => {
    expect(canonicalize({ speed: 94500000 })).toBe('{"speed":94500000}');
  });

  it("prints a fractional latency without trailing zeros beyond what toString yields", () => {
    expect(canonicalize({ latency: 38.2 })).toBe('{"latency":38.2}');
  });

  it("emits non-ASCII text verbatim, unescaped", () => {
    expect(canonicalize({ city: "台北市" })).toBe('{"city":"台北市"}');
  });

  it("escapes only quote, backslash, and control characters", () => {
    expect(canonicalize({ s: 'a"b\\c\nd' })).toBe('{"s":"a\\"b\\\\c\\nd"}');
  });

  it("preserves array order and adds no whitespace", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalize({ a: [1, 2], b: { c: 3 } })).toBe('{"a":[1,2],"b":{"c":3}}');
  });

  it("round-trips null, booleans, and nested structures deterministically", () => {
    const built1: Record<string, unknown> = {};
    built1.z = null;
    built1.a = true;
    built1.m = { nested: [1, { x: 1, y: 2 }] };

    const built2: Record<string, unknown> = {};
    built2.a = true;
    built2.m = { nested: [1, { y: 2, x: 1 }] };
    built2.z = null;

    expect(canonicalize(built1)).toBe(canonicalize(built2));
  });
});

describe("computeResultHash", () => {
  it("is deterministic across two different key insertion orders", async () => {
    const built1 = { room: "R", peerId: "P", nested: { a: 1, b: 2 } };
    const built2: Record<string, unknown> = {};
    built2.nested = { b: 2, a: 1 };
    built2.peerId = "P";
    built2.room = "R";

    const [hash1, hash2] = await Promise.all([
      computeResultHash(built1),
      computeResultHash(built2),
    ]);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs when data actually differs", async () => {
    const hash1 = await computeResultHash({ a: 1 });
    const hash2 = await computeResultHash({ a: 2 });
    expect(hash1).not.toBe(hash2);
  });
});
