import type { ConnectionType } from "~/lib/webrtc";

const COPY: Record<ConnectionType, { label: string; className: string }> = {
  DIRECT: {
    label: "Direct connection",
    className:
      "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  },
  RELAY: {
    label: "Relayed via TURN",
    className: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  },
  UNKNOWN: {
    label: "Connection type unknown",
    className: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  },
};

/**
 * Persistent, non-dismissable connection-type indicator (S4). Shared by
 * the room page, Phase 4's result view, and Phase 5's results pages, so
 * the same badge — and the same honesty about a relayed connection — shows
 * up everywhere a connection type is known.
 */
export function ConnectionBadge({ type }: { type: ConnectionType }) {
  const { label, className } = COPY[type];
  return (
    <span
      className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${className}`}
    >
      {label}
    </span>
  );
}
