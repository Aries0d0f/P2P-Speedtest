import { useMemo } from "react";
import { buildQrMatrix } from "~/lib/qr";

const QUIET_ZONE = 4; // modules of border, the QR spec's minimum

/**
 * Inline SVG QR code for a room link (5.6). Plain `<rect>` modules rather
 * than a canvas/data-URI, so the server and the client render the exact
 * same markup for the same `value` — nothing to disagree on at hydration —
 * and a fixed white backing keeps it scannable regardless of the page's own
 * light/dark theme.
 */
export function QrCode({ value, size = 176 }: { value: string; size?: number }) {
  const matrix = useMemo(() => buildQrMatrix(value), [value]);
  const dimension = matrix.length + QUIET_ZONE * 2;

  return (
    <svg
      viewBox={`0 0 ${dimension} ${dimension}`}
      width={size}
      height={size}
      role="img"
      aria-label="QR code for the room link"
      className="rounded-lg bg-white p-1"
    >
      {matrix.map((row, y) =>
        row.map((dark, x) =>
          dark ? <rect key={`${x}-${y}`} x={x + QUIET_ZONE} y={y + QUIET_ZONE} width={1} height={1} /> : null,
        ),
      )}
    </svg>
  );
}
