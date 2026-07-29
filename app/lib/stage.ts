/**
 * Stage identity and fixed sender/receiver roles (S5, 04-throughput
 * measurement.md). Shared by `throughput.ts`'s binary frame header and
 * `control-channel.ts`'s stage-sequencing FSM, so both speak the same
 * 1-byte `stageId` and the same never-negotiated slot mapping.
 */

export type Slot = 0 | 1;

/** Numeric wire form of a stage, used directly as the frame header's
 * 1-byte `stageId` (4.1). */
export type StageId = 0 | 1 | 2;

export const DOWNLOAD: StageId = 0;
export const UPLOAD: StageId = 1;
export const DUPLEX: StageId = 2;

/** Always run in this order (S5): the directional stages complete and are
 * fully banked before duplex starts. */
export const STAGE_ORDER: readonly StageId[] = [DOWNLOAD, UPLOAD, DUPLEX];

export type StageName = "download" | "upload" | "duplex";

const STAGE_NAMES: Record<StageId, StageName> = {
  0: "download",
  1: "upload",
  2: "duplex",
};

export function stageName(stage: StageId): StageName {
  return STAGE_NAMES[stage];
}

export function isStageId(value: unknown): value is StageId {
  return value === 0 || value === 1 || value === 2;
}

/** Directional stages land in `bandwidth.directional`; duplex lands in
 * `bandwidth.duplex` (S5) — the two groups are never averaged together. */
export type BandwidthGroup = "directional" | "duplex";

export function bandwidthGroup(stage: StageId): BandwidthGroup {
  return stage === DUPLEX ? "duplex" : "directional";
}

/** The other of the two slots. With exactly two peers per room (S2), this
 * is also every stage's sender/receiver relationship: whichever slot isn't
 * the receiver on a given edge is that edge's sender. */
export function otherSlot(slot: Slot): Slot {
  return slot === 0 ? 1 : 0;
}

/** Fixed by slot number (S5), never negotiated: download is slot 0 -> slot
 * 1, upload is slot 1 -> slot 0, duplex runs both directions at once. */
export function isSender(stage: StageId, slot: Slot): boolean {
  if (stage === DUPLEX) return true;
  return stage === DOWNLOAD ? slot === 0 : slot === 1;
}

export function isReceiver(stage: StageId, slot: Slot): boolean {
  if (stage === DUPLEX) return true;
  return stage === DOWNLOAD ? slot === 1 : slot === 0;
}

/** Derives an edge's sender from the receiver's slot alone (4.3: "a share
 * with a forged direction cannot flip an edge") — never taken from a
 * peer-supplied field. */
export function senderSlotFor(receiverSlot: Slot): Slot {
  return otherSlot(receiverSlot);
}

/** One sealed, receiver-observed edge (4.2's "stage-result" payload
 * shape). `bytes`/`durationMs` are the post-ramp-up window; `latency`/
 * `jitter` are that same peer's own aggregate over that stage's window
 * (S5). Every field is finite and `0 <= chunksSeen <= chunksExpected`. */
export interface Measurement {
  bytes: number;
  durationMs: number;
  latency: number;
  jitter: number;
  chunksSeen: number;
  chunksExpected: number;
}

/** One entry in a peer's local stage bank: the edge received by
 * `receiverSlot` during `stageId`. Edge identity is exactly
 * `(runId, stageId, receiverSlot)` — `runId` is implicit (the bank is
 * always scoped to one run). */
export interface StageBankEntry {
  stageId: StageId;
  receiverSlot: Slot;
  measurement: Measurement;
}

export function edgeKey(stageId: StageId, receiverSlot: Slot): string {
  return `${stageId}:${receiverSlot}`;
}

/** Every edge key a `SUCCEED` run must have banked: one per directional
 * stage, two for duplex. */
export function allEdgeKeys(): string[] {
  return [edgeKey(DOWNLOAD, 1), edgeKey(UPLOAD, 0), edgeKey(DUPLEX, 0), edgeKey(DUPLEX, 1)];
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Structural + range validation for a `Measurement` from an untrusted
 * peer (`stage-result`, `result-share`): finite, non-negative, and
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
