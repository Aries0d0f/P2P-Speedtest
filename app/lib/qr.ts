/**
 * QR encoding for the room link (5.6 — main-plan's "joinable by link/QR"
 * criterion). Deliberately imports only `qrcode`'s synchronous encoder core
 * (`qrcode/lib/core/qrcode.js`), never the package's top-level module: that
 * top level also pulls in its canvas and Node `fs` renderers, and Workers'
 * runtime has neither — this deep import is the part with no such
 * dependency, so it works unchanged in the SSR bundle and the browser one.
 */
import { create } from "qrcode/lib/core/qrcode.js";

/** The QR code's module matrix as plain booleans (dark/light per cell).
 * Encoding is a pure function of `text`, so this renders identically on the
 * server and the client for the same room link — no data-URI or canvas step
 * to disagree between them. */
export function buildQrMatrix(text: string): boolean[][] {
  const qr = create(text, { errorCorrectionLevel: "M" });
  const { size } = qr.modules;
  const matrix: boolean[][] = [];
  for (let row = 0; row < size; row++) {
    const cells: boolean[] = [];
    for (let col = 0; col < size; col++) cells.push(qr.modules.get(row, col) === 1);
    matrix.push(cells);
  }
  return matrix;
}
