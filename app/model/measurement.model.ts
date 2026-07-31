/**
 * Everything a run measures: one sealed edge, its live progress, and the
 * latency aggregates over the same control-channel ping stream.
 */

import type { Slot } from "./signaling.model";
import type { StageId } from "./stage.model";

/** One sealed, receiver-observed edge (4.2's `stage-result` payload).
 * `bytes`/`durationMs` are the post-ramp-up window; `latency`/`jitter` are
 * that same peer's own aggregate over that stage's window (S5). */
export interface Measurement {
  bytes: number;
  durationMs: number;
  latency: number;
  jitter: number;
  chunksSeen: number;
  chunksExpected: number;
}

/** What the bulk receiver can seal on its own — the latency half comes from
 * the stage's own ping window, which the receiver never sees. */
export type SealedMeasurement = Omit<Measurement, "latency" | "jitter">;

/** A live, best-effort reading of an open receive window. */
export interface MeasurementProgress {
  elapsedMs: number;
  bytes: number;
  chunksSeen: number;
  highestSeqPlusOne: number;
}

/** Edge identity is exactly `(runId, stageId, receiverSlot)`; `runId` is
 * implicit because a bank is always scoped to one run. */
export interface StageEdge {
  stageId: StageId;
  receiverSlot: Slot;
}

export type StageBankEntry = StageEdge & { measurement: Measurement };
export type StageProgress = StageEdge & MeasurementProgress;

export interface Sample {
  seq: number;
  rttMs: number;
}

/** `jitterMs` is `null` until two samples exist — never `0`, which would read
 * as a measured absence of jitter. */
export interface Latency {
  rttMs: number;
  jitterMs: number | null;
}

/** A finalized window: enough samples for both figures. */
export type LatencyAggregate = { [K in keyof Latency]: NonNullable<Latency[K]> };

export type LiveLatency = Latency & { sampleCount: number };

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Structural + range validation for a `Measurement` from an untrusted peer
 * (`stage-result`, `result-share`): finite, non-negative, and
 * `0 <= chunksSeen <= chunksExpected` with `chunksExpected > 0` (4.2). */
export function isValidMeasurement(value: unknown): value is Measurement {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  if (
    !isFiniteNonNegative(m.bytes) ||
    !isFiniteNonNegative(m.durationMs) ||
    !isFiniteNonNegative(m.latency) ||
    !isFiniteNonNegative(m.jitter) ||
    !isFiniteNonNegative(m.chunksSeen) ||
    !isFiniteNonNegative(m.chunksExpected)
  ) {
    return false;
  }
  if (m.chunksExpected as number <= 0) return false;
  if ((m.chunksSeen as number) > (m.chunksExpected as number)) return false;
  return true;
}
