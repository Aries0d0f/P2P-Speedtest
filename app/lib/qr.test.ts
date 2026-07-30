import { describe, expect, it } from "vitest";
import { buildQrMatrix } from "./qr";

describe("buildQrMatrix", () => {
  it("builds a square matrix with at least one dark module", () => {
    const matrix = buildQrMatrix("https://sws.aries0d0f.me/room/4G7QZKX9M");
    expect(matrix.length).toBeGreaterThan(0);
    for (const row of matrix) expect(row).toHaveLength(matrix.length);
    expect(matrix.some((row) => row.some((cell) => cell))).toBe(true);
  });

  it("is deterministic for the same input", () => {
    const a = buildQrMatrix("https://sws.aries0d0f.me/room/4G7QZKX9M");
    const b = buildQrMatrix("https://sws.aries0d0f.me/room/4G7QZKX9M");
    expect(a).toEqual(b);
  });

  it("grows for a longer input", () => {
    const short = buildQrMatrix("a");
    const long = buildQrMatrix("https://sws.aries0d0f.me/room/4G7QZKX9M?withExtraQueryParamsMakingItLonger=1");
    expect(long.length).toBeGreaterThan(short.length);
  });
});
