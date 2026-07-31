/**
 * The whole control-channel vocabulary, as one discriminated union.
 *
 * Every message is run-scoped by a `runId` the receiver already knows, so a
 * stale or foreign run's message is rejected before its shape is even looked
 * at. Nothing here is trusted: each payload's per-type validation lives in
 * `lib/control-message.ts`.
 */

import type { Slot } from "./signaling.model";
import type { StageId } from "./stage.model";
import type {
  LatencyAggregate,
  Measurement,
  MeasurementProgress,
} from "./measurement.model";
import type { ResultShare } from "./result.model";

/** Every name the control channel may carry. Anything outside this list is
 * rejected outright rather than silently accepted. */
export const CONTROL_MESSAGE_TYPES = [
  "channel-ready",
  "ping",
  "pong",
  "latency-ready",
  "stage-prepare",
  "stage-armed",
  "stage-start",
  "stage-complete",
  "measurement-progress",
  "stage-result",
  "stage-result-ack",
  "peer-profile",
  "test-abort",
  "result-share",
] as const;

export type ControlMessageType = (typeof CONTROL_MESSAGE_TYPES)[number];

export type ControlMessage =
  | { runId: string; type: "channel-ready"; payload: Record<string, never> }
  | { runId: string; type: "ping"; seq: number; payload: Record<string, never> }
  | { runId: string; type: "pong"; seq: number; payload: Record<string, never> }
  | { runId: string; type: "latency-ready"; payload: { aggregate: LatencyAggregate | null } }
  | {
      runId: string;
      type: "stage-prepare" | "stage-armed" | "stage-start";
      stageId: StageId;
      payload: Record<string, never>;
    }
  | {
      runId: string;
      type: "stage-complete";
      stageId: StageId;
      payload: { sentMeasuredChunks?: number };
    }
  | {
      runId: string;
      type: "measurement-progress";
      stageId: StageId;
      receiverSlot: Slot;
      progressSeq: number;
      payload: MeasurementProgress;
    }
  | {
      runId: string;
      type: "stage-result";
      stageId: StageId;
      receiverSlot: Slot;
      payload: { measurement: Measurement };
    }
  | {
      runId: string;
      type: "stage-result-ack";
      stageId: StageId;
      receiverSlot: Slot;
      payload: Record<string, never>;
    }
  | { runId: string; type: "test-abort"; payload: { status: "FAILED" | "CANCELED"; reason: string } }
  | { runId: string; type: "result-share"; payload: ResultShare }
  /** `payload` is deliberately `unknown`: the decoder run-scopes the envelope
   * but does not sanitize the profile, so the caller must still pass it
   * through `sanitizeIncomingProfile`/`validateInitialProfile`. Typing it as a
   * `PeerProfile` here would assert a guarantee no one has made. */
  | { runId: string; type: "peer-profile"; payload: unknown };

export type ControlMessageOf<T extends ControlMessageType> = Extract<ControlMessage, { type: T }>;

/** The four types `LatencySession` owns. */
export type LatencyMessage = ControlMessageOf<
  "channel-ready" | "ping" | "pong" | "latency-ready"
>;

/** The nine types `StageOrchestrator` and `TerminalController` own. */
export type StageMessage = ControlMessageOf<
  | "stage-prepare"
  | "stage-armed"
  | "stage-start"
  | "stage-complete"
  | "measurement-progress"
  | "stage-result"
  | "stage-result-ack"
  | "test-abort"
  | "result-share"
>;
