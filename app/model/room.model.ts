/** The room's own state machine: what phase it is in, what it has measured so
 * far, and how it ended. */

import type { ConnectionType } from "./connection.model";
import type {
  LatencyAggregate,
  LiveLatency,
  StageProgress,
} from "./measurement.model";
import type { PeerIdentity, PeerProfile } from "./peer.model";
import type { RunEndedReason, TestConfigPayload } from "./signaling.model";
import type { StageId } from "./stage.model";
import type { ConfirmedProfile } from "./peer.model";
import type { P2PSpeedtestResult, ResultStatus } from "./result.model";
import type { ValidationResult } from "./storage.model";

export type RoomPhase =
  | "waiting"
  | "pairing"
  | "paired"
  | "testing"
  | "finalizing"
  | "result";

/** Ways this browser itself decides the run is over, as distinct from the
 * reasons the DO reports. Enumerated so terminal copy is exhaustive rather
 * than a `Record<string, string>` with a fallback. */
export type LocalFailureReason =
  | "ice-failed"
  | "negotiation-failed"
  | "profile-timeout"
  | "channel-closed"
  | "latency-ready-timeout"
  | "stage-timeout"
  | "user-canceled"
  | "finalization-setup-failed";

export type TerminalReason = RunEndedReason | LocalFailureReason;

export type FinalizeTrigger =
  | { kind: "clean" }
  | { kind: "local-abort"; status: "CANCELED" | "FAILED"; reason: string }
  | { kind: "remote-abort"; status: "CANCELED" | "FAILED"; reason: string }
  | { kind: "remote-run-ended"; reason: string };

export interface TerminalOutcome {
  status: ResultStatus;
  record: P2PSpeedtestResult | null;
  validation: ValidationResult | null;
}

export interface RoomState {
  phase: RoomPhase;
  runId: string | null;
  self: (PeerIdentity & { expiresAt: string }) | null;
  other: PeerIdentity | null;
  /** The profile *as this browser sent it* — already privacy-projected, so
   * both peers agree on which fields exist. */
  selfProfile: PeerProfile | null;
  otherProfile: PeerProfile | null;
  connectionType: ConnectionType;
  liveLatency: LiveLatency | null;
  /** `undefined` while the latency sub-phase is still running, `null` when it
   * finalized without a usable aggregate. */
  latencyBaseline: LatencyAggregate | null | undefined;
  stageId: StageId | null;
  /** `runId` is the run the entries were observed during; a mismatch means a
   * stale bank was retained, and it is dropped rather than displayed. */
  stageProgress: { runId: string | null; entries: Record<string, StageProgress> };
  terminal: { reason: TerminalReason } | null;
  outcome: TerminalOutcome | null;
}

/** The shared mutable run state the room's sub-hooks read from each other's
 * callbacks. Created once per run and threaded through, rather than
 * reconstructed from React state that a callback may not have seen yet. */
export interface RoomRunContext {
  token: number;
  slug: string;
  profile: ConfirmedProfile;
  runId: string | null;
  self: PeerIdentity | null;
  other: PeerIdentity | null;
  runTimestamp: string | null;
  selfProfile: PeerProfile | null;
  otherProfile: PeerProfile | null;
  connectionType: ConnectionType;
  phase: RoomPhase;
  terminal: boolean;
  testConfig: TestConfigPayload | null;
}
