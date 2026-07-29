/**
 * Message protocol between the main thread and each `bulk-worker.ts`
 * instance (worker-transport revision — see 04-throughput-measurement.md's
 * revision log). Shared by both sides so the shapes can't drift apart.
 *
 * One worker owns exactly one transferred `RTCDataChannel` for the whole
 * run, reused across all three stages; `start-stage` reconfigures its role
 * each time. The worker reuses `throughput.ts`'s `BulkSender`/
 * `BulkReceiver` directly (a transferred `RTCDataChannel` satisfies
 * `BulkChannel` exactly as it does on the main thread) — this protocol
 * only carries the bookkeeping those classes can't decide for themselves:
 * which stage, which role(s), and the striped seq range this worker owns.
 */

import type { StageId } from "./stage";

export interface SenderStageConfig {
  chunkBytes: number;
  maxDurationMs: number;
  maxBytes: number;
  rampUpMs: number;
  /** This worker's disjoint slice of the stage's shared measured-sequence
   * space (4.1's striping revision) — `seqStart, seqStart + seqStride, ...`. */
  seqStart: number;
  seqStride: number;
}

export interface ReceiverStageConfig {
  maxDurationMs: number;
  rampUpMs: number;
}

export type MainToWorkerMessage =
  | { type: "init"; runId: string; workerId: number; channel: RTCDataChannel }
  // Two-phase, matching StageOrchestrator's own transport barrier: `prepare-stage`
  // builds this worker's BulkSender (not yet started) and BulkReceiver (armed
  // immediately — "counters reset, receiver ready"); `start-sending` is the
  // separate, later signal (both peers armed) that actually begins transmission.
  // One combined message per stage rather than two separate sender/receiver
  // messages, because handling it resets prior stage state — a second message
  // would wipe out the first when duplex needs both roles at once.
  | {
      type: "prepare-stage";
      stageId: StageId;
      sender: SenderStageConfig | null;
      receiver: ReceiverStageConfig | null;
    }
  | { type: "start-sending"; stageId: StageId }
  | { type: "finalize-receiver"; stageId: StageId; sentMeasuredChunksTotal: number }
  /** Run-scoped teardown: closes the channel and ends the worker. Never
   * used between stages — `prepare-stage` alone resets per-stage state. */
  | { type: "close" };

export interface ReceiverSnapshotMessage {
  elapsedMs: number;
  bytes: number;
  chunksSeen: number;
  highestSeqPlusOne: number;
}

export interface SealedMeasurementMessage {
  bytes: number;
  durationMs: number;
  chunksSeen: number;
  chunksExpected: number;
}

export type ReceiverCloseReasonMessage = "end-marker" | "quiet-period" | "hard-deadline";

export type WorkerToMainMessage =
  | { type: "ready"; workerId: number }
  | { type: "sender-done"; workerId: number; stageId: StageId; localSentCount: number }
  | { type: "receiver-progress"; workerId: number; stageId: StageId; snapshot: ReceiverSnapshotMessage }
  | {
      type: "receiver-window-closed";
      workerId: number;
      stageId: StageId;
      reason: ReceiverCloseReasonMessage;
    }
  | {
      type: "receiver-sealed";
      workerId: number;
      stageId: StageId;
      measurement: SealedMeasurementMessage | null;
    }
  | { type: "worker-error"; workerId: number; message: string };
