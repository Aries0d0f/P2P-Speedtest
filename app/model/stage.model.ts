/**
 * Stage identity and fixed sender/receiver roles (S5). The 1-byte wire
 * `stageId` and the never-negotiated slot mapping both live here.
 */

import type { Slot } from "./signaling.model";

/** Numeric wire form of a stage, used directly as the bulk frame header's
 * 1-byte `stageId`. */
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

export function isSlot(value: unknown): value is Slot {
  return value === 0 || value === 1;
}

/** The other of the two slots. With exactly two peers per room (S2), this is
 * also every stage's sender/receiver relationship. */
export function otherSlot(slot: Slot): Slot {
  return slot === 0 ? 1 : 0;
}

/** Fixed by slot number (S5), never negotiated: download is slot 0 -> slot 1,
 * upload is slot 1 -> slot 0, duplex runs both directions at once. */
export function isSender(stage: StageId, slot: Slot): boolean {
  if (stage === DUPLEX) return true;
  return stage === DOWNLOAD ? slot === 0 : slot === 1;
}

export function isReceiver(stage: StageId, slot: Slot): boolean {
  if (stage === DUPLEX) return true;
  return stage === DOWNLOAD ? slot === 1 : slot === 0;
}

/** Derives an edge's sender from the receiver's slot alone — never taken from
 * a peer-supplied field, so a share with a forged direction cannot flip an
 * edge (4.3). */
export function senderSlotFor(receiverSlot: Slot): Slot {
  return otherSlot(receiverSlot);
}

export function edgeKey(stageId: StageId, receiverSlot: Slot): string {
  return `${stageId}:${receiverSlot}`;
}

/** Every edge key a `SUCCEED` run must have banked: one per directional
 * stage, two for duplex. */
export function allEdgeKeys(): string[] {
  return [edgeKey(DOWNLOAD, 1), edgeKey(UPLOAD, 0), edgeKey(DUPLEX, 0), edgeKey(DUPLEX, 1)];
}
