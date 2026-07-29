/**
 * The shared checksum used by both peers when assembling a result and by
 * Phase 5's import path (4.3). `computeResultHash` is a **checksum, not a
 * signature** (S6) — it detects corruption and cross-peer disagreement, not
 * origin or authenticity. Name and comment it that way so nobody later
 * builds a trust decision on it.
 *
 * `canonicalize` implements RFC 8785 (JCS), not "RFC 8785-shaped." Key
 * sorting is the easy half; the half that actually determines
 * interoperability is number/string serialization, both implemented exactly
 * per the spec below rather than left to `JSON.stringify`'s own rules.
 */

/**
 * ECMAScript `Number::toString` per JCS: integers print with no `+`, no
 * trailing `.0`, and exponent form only outside the 1e21/1e-7 boundaries
 * that `Number.prototype.toString` already applies to `number` values. JS's
 * built-in `toString()` for `number` already implements this exact
 * algorithm (ECMA-262 Number::toString), so no bespoke formatting logic is
 * needed here beyond rejecting non-finite input.
 */
function serializeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`canonicalize: non-finite number ${value}`);
  }
  // Distinguish -0 from 0: JCS (via ECMA-262 Number::toString) prints both
  // as "0", so no special case is needed — `(-0).toString() === "0"`.
  return value.toString();
}

/** JSON's minimal escaping: `"`, `\`, and control characters only. Non-ASCII
 * text is emitted verbatim (JCS explicitly does not escape it). */
function serializeString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (code === 0x08) out += "\\b";
    else if (code === 0x09) out += "\\t";
    else if (code === 0x0a) out += "\\n";
    else if (code === 0x0c) out += "\\f";
    else if (code === 0x0d) out += "\\r";
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out + '"';
}

function serializeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") return serializeNumber(value);
  if (typeof value === "string") return serializeString(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeValue(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    // Keys sorted by UTF-16 code unit, as JCS specifies — the default
    // ordering of `Array.prototype.sort` on strings is exactly this.
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const entries = keys.map(
      (key) =>
        `${serializeString(key)}:${serializeValue((value as Record<string, unknown>)[key])}`,
    );
    return `{${entries.join(",")}}`;
  }
  throw new Error(`canonicalize: unsupported value of type ${typeof value}`);
}

/** RFC 8785 JSON Canonicalization Scheme. No whitespace anywhere; array
 * order is preserved; object keys are sorted. Deterministic regardless of
 * the input object's own key insertion order — this is what lets two
 * independently assembled records serialize to identical bytes. */
export function canonicalize(data: unknown): string {
  return serializeValue(data);
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 hex digest of `canonicalize(data)`. One implementation, used by
 * every assembling peer and by Phase 5's import verification — a hash
 * written twice is one that will eventually disagree with itself. */
export async function computeResultHash(data: unknown): Promise<string> {
  return sha256Hex(canonicalize(data));
}
