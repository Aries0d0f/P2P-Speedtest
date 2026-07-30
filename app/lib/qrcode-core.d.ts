/**
 * `qrcode`'s deep encoder-only entry point has no published types (only the
 * top-level `qrcode` module, which pulls in canvas/fs renderers, does). This
 * mirrors just the shape `~/lib/qr.ts` reads off it.
 */
declare module "qrcode/lib/core/qrcode.js" {
  export interface QrBitMatrix {
    size: number;
    get(row: number, col: number): number;
  }

  export interface QrCode {
    modules: QrBitMatrix;
  }

  export function create(
    text: string,
    options?: { errorCorrectionLevel?: "L" | "M" | "Q" | "H" },
  ): QrCode;
}
