import type { TerminalReason } from "~/model/room.model";

/**
 * Exhaustive over `TerminalReason`, so a new reason fails typecheck instead of
 * silently rendering a fallback. The three that read as "The room ended (…)"
 * are exactly what the old `??` fallback produced — spelled out here so they
 * are visible to whoever writes real copy for them, rather than invisible.
 */
const TERMINAL_COPY: Record<TerminalReason, string> = {
  "peer-left": "The other peer disconnected.",
  expired: "This room expired.",
  complete: "The test finished.",
  "finalization-timeout": "The test could not finish in time.",
  "ice-failed": "Couldn't establish a connection.",
  "negotiation-failed": "Couldn't establish a connection.",
  "profile-timeout": "The other peer never confirmed who they are.",
  "channel-closed": "The connection was lost before pairing finished.",
  "latency-ready-timeout": "The other peer's latency measurement never arrived.",
  "stage-timeout": "The room ended (stage-timeout).",
  "user-canceled": "The room ended (user-canceled).",
  "finalization-setup-failed": "The room ended (finalization-setup-failed).",
};

export function terminalMessage(reason: TerminalReason): string {
  return TERMINAL_COPY[reason];
}

/** Expiry reads as "this room expired," not a connection error; a genuine
 * local/negotiation failure reads as an error; a clean peer-left/complete
 * reads as neutral news rather than either. */
export function terminalTone(reason: TerminalReason): "expired" | "error" | "neutral" {
  if (reason === "expired") return "expired";
  if (
    reason === "ice-failed" ||
    reason === "negotiation-failed" ||
    reason === "profile-timeout" ||
    reason === "channel-closed" ||
    reason === "finalization-timeout" ||
    reason === "latency-ready-timeout"
  ) {
    return "error";
  }
  return "neutral";
}
