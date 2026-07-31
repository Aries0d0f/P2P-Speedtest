/**
 * Bulk frame header (4.1): runId (16B) | stageId (1B) | seq (4B) | kind (1B).
 * Mandatory on every chunk — `seq` is what excludes a straggler from a
 * previous stage arithmetically rather than merely "unlikely" on an unordered,
 * unreliable channel, and `loss` falls out of it for free.
 */

import type { StageId } from "./stage.model";

export type BulkFrameKind = "ramp-up" | "measured" | "end";

export const KIND_CODES: Record<BulkFrameKind, number> = { "ramp-up": 0, measured: 1, end: 2 };
export const KIND_NAMES: Record<number, BulkFrameKind> = { 0: "ramp-up", 1: "measured", 2: "end" };

export const BULK_FRAME_HEADER_BYTES = 22;

export interface BulkFrame {
  runId: string;
  stageId: StageId;
  seq: number;
  kind: BulkFrameKind;
  data: Uint8Array;
}

/** The subset of `RTCDataChannel` the send loop needs — real channels satisfy
 * this directly; tests supply a fake implementing the same shape. */
export interface BulkChannel {
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  send(data: ArrayBuffer): void;
  addEventListener(type: "bufferedamountlow", listener: () => void): void;
  removeEventListener(type: "bufferedamountlow", listener: () => void): void;
}
