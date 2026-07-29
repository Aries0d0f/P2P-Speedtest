/**
 * Bulk transfer over the unordered, non-retransmitting `bulk` channel (4.1,
 * S5). One channel carries every stage in both directions — the frame
 * header says which stage a chunk belongs to, so a second channel would add
 * negotiation surface for nothing (Phase 2 already creates it with
 * `{ ordered: false, maxRetransmits: 0 }`).
 *
 * `control-channel.ts` (4.2) owns the stage-sequencing FSM and everything
 * on the reliable control channel, including `measurement-progress`; this
 * module only knows about the binary bulk channel itself — framing, the
 * send loop's backpressure, and the receiver's counters.
 */

import { bytesToUuid, uuidToBytes } from "./uuid-bytes";
import { isStageId, type StageId } from "./stage";

// --- Frame header (4.1 design notes) ---------------------------------------
//
// runId (16B) | stageId (1B) | seq (4B) | kind (1B: 0=ramp-up, 1=measured,
// 2=end). Mandatory on every chunk: `seq` is what excludes a straggler from
// a previous stage arithmetically rather than merely "unlikely" on an
// unordered, unreliable channel, and `loss` falls out of it for free.

export type BulkFrameKind = "ramp-up" | "measured" | "end";

const KIND_CODES: Record<BulkFrameKind, number> = { "ramp-up": 0, measured: 1, end: 2 };
const KIND_NAMES: Record<number, BulkFrameKind> = { 0: "ramp-up", 1: "measured", 2: "end" };

export const BULK_FRAME_HEADER_BYTES = 22;

export interface BulkFrame {
  runId: string;
  stageId: StageId;
  seq: number;
  kind: BulkFrameKind;
  data: Uint8Array;
}

/** Builds one wire frame. Throws on a shape the sender should never
 * produce itself (an empty ramp-up/measured payload, or a non-empty end
 * payload) — those are guarded here so a bug can't silently emit a frame
 * `parseBulkFrame` would then reject on the other side. */
export function encodeBulkFrame(frame: {
  runId: string;
  stageId: StageId;
  seq: number;
  kind: BulkFrameKind;
  data?: Uint8Array;
}): ArrayBuffer {
  const data = frame.data ?? new Uint8Array(0);
  if (frame.kind === "end" && data.byteLength !== 0) {
    throw new RangeError("encodeBulkFrame: end frame must carry no payload");
  }
  if (frame.kind !== "end" && data.byteLength === 0) {
    throw new RangeError(`encodeBulkFrame: ${frame.kind} frame must carry a non-empty payload`);
  }
  if (!Number.isInteger(frame.seq) || frame.seq < 0 || frame.seq > 0xffffffff) {
    throw new RangeError(`encodeBulkFrame: seq out of range (${frame.seq})`);
  }

  const buffer = new ArrayBuffer(BULK_FRAME_HEADER_BYTES + data.byteLength);
  const bytes = new Uint8Array(buffer);
  bytes.set(uuidToBytes(frame.runId), 0);
  bytes[16] = frame.stageId;
  new DataView(buffer).setUint32(17, frame.seq, false);
  bytes[21] = KIND_CODES[frame.kind];
  bytes.set(data, BULK_FRAME_HEADER_BYTES);
  return buffer;
}

/** Rejects a truncated header, an unknown kind, an end marker carrying a
 * payload, and a ramp-up/measured frame carrying none — the terminal
 * marker is an explicit wire variant, not an out-of-band convention (4.1). */
export function parseBulkFrame(data: ArrayBuffer): BulkFrame | null {
  if (data.byteLength < BULK_FRAME_HEADER_BYTES) return null;
  const bytes = new Uint8Array(data);
  const stageId = bytes[16];
  if (!isStageId(stageId)) return null;
  const kind = KIND_NAMES[bytes[21]];
  if (kind === undefined) return null;

  let runId: string;
  try {
    runId = bytesToUuid(bytes.subarray(0, 16));
  } catch {
    return null;
  }
  const seq = new DataView(data).getUint32(17, false);
  const payload = bytes.subarray(BULK_FRAME_HEADER_BYTES);

  if (kind === "end") {
    if (payload.byteLength !== 0) return null;
  } else if (payload.byteLength === 0) {
    return null;
  }
  return { runId, stageId, seq, kind, data: payload };
}

// --- Sender ------------------------------------------------------------

/** The subset of `RTCDataChannel` the send loop needs — real channels
 * satisfy this directly; tests supply a fake implementing the same shape. */
export interface BulkChannel {
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  send(data: ArrayBuffer): void;
  addEventListener(type: "bufferedamountlow", listener: () => void): void;
  removeEventListener(type: "bufferedamountlow", listener: () => void): void;
}

/** A short warm-up period of discarded `ramp-up` chunks before measurement
 * begins, so early buffering/congestion-window effects don't distort the
 * measured window. Ramp-up chunks never consume the measured sequence
 * space (4.1 design notes). Exported so `BulkReceiver`'s hard deadline can
 * budget for it without duplicating the constant. */
export const RAMP_UP_MS = 500;

// A multiple of a typical chunk size so the send loop keeps a healthy
// amount of data queued between `bufferedamountlow` events rather than
// firing one per chunk. Client-side only — the numbers that actually shape
// a test (duration, byte cap, chunk size) come from server-issued
// `test-config`, never this.
const BUFFERED_LOW_THRESHOLD_CHUNKS = 4;

export interface BulkSenderOptions {
  channel: BulkChannel;
  runId: string;
  stageId: StageId;
  chunkBytes: number;
  maxDurationMs: number;
  maxBytes: number;
  rampUpMs?: number;
  /** Fires once, when the measured send loop and ramp-up are both done and
   * the `end` marker has been sent. Carries `sentMeasuredChunks` — the
   * authoritative denominator a stage's `stage-complete` must report. */
  onComplete?: (sentMeasuredChunks: number) => void;
}

type SenderPhase = "ramp-up" | "measured" | "done";

/** Event-driven send loop against `bufferedAmount`/`bufferedamountlow`
 * (4.1): sends until the channel's buffer crosses its low-water threshold,
 * then waits for the browser to tell it there's room again, rather than
 * ever queuing unbounded data client-side. */
export class BulkSender {
  private readonly opts: Required<Omit<BulkSenderOptions, "onComplete">> &
    Pick<BulkSenderOptions, "onComplete">;
  private readonly payload: Uint8Array;

  private phase: SenderPhase = "ramp-up";
  private nextSeq = 0;
  private bytesSent = 0;
  private rampUpEndsAt = 0;
  private measuredDeadlineAt = 0;
  private started = false;
  private stopped = false;

  private readonly onBufferedLow = () => this.pump();

  constructor(opts: BulkSenderOptions) {
    this.opts = { rampUpMs: RAMP_UP_MS, onComplete: opts.onComplete, ...opts };
    this.payload = new Uint8Array(this.opts.chunkBytes);
  }

  get sentMeasuredChunks(): number {
    return this.nextSeq;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const now = Date.now();
    this.rampUpEndsAt = now + this.opts.rampUpMs;
    this.opts.channel.bufferedAmountLowThreshold =
      this.opts.chunkBytes * BUFFERED_LOW_THRESHOLD_CHUNKS;
    this.opts.channel.addEventListener("bufferedamountlow", this.onBufferedLow);
    this.pump();
  }

  /** Stops the loop without sending the `end` marker — for an aborted run,
   * where no valid stage result will ever be assembled from this stage
   * anyway. Idempotent. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.opts.channel.removeEventListener("bufferedamountlow", this.onBufferedLow);
  }

  private pump(): void {
    if (this.stopped || this.phase === "done") return;
    while (this.opts.channel.bufferedAmount < this.opts.channel.bufferedAmountLowThreshold) {
      if (!this.sendNext()) return;
    }
  }

  /** Sends exactly one frame and returns whether the loop should keep
   * going. Ramp-up falls through into measured immediately once its timer
   * elapses, in the same backpressure-gated pass. */
  private sendNext(): boolean {
    const now = Date.now();

    if (this.phase === "ramp-up") {
      if (now >= this.rampUpEndsAt) {
        this.phase = "measured";
        this.measuredDeadlineAt = now + this.opts.maxDurationMs;
        return this.sendNext();
      }
      this.send({ runId: this.opts.runId, stageId: this.opts.stageId, seq: 0, kind: "ramp-up", data: this.payload });
      return true;
    }

    // measured
    if (now >= this.measuredDeadlineAt || this.bytesSent >= this.opts.maxBytes) {
      this.finish();
      return false;
    }
    const seq = this.nextSeq++;
    this.send({ runId: this.opts.runId, stageId: this.opts.stageId, seq, kind: "measured", data: this.payload });
    this.bytesSent += this.payload.byteLength;
    return true;
  }

  private finish(): void {
    this.phase = "done";
    this.send({
      runId: this.opts.runId,
      stageId: this.opts.stageId,
      seq: this.nextSeq,
      kind: "end",
      data: new Uint8Array(0),
    });
    this.stop();
    this.opts.onComplete?.(this.nextSeq);
  }

  private send(frame: { runId: string; stageId: StageId; seq: number; kind: BulkFrameKind; data: Uint8Array }): void {
    try {
      this.opts.channel.send(encodeBulkFrame(frame));
    } catch {
      // Channel already closed — the surrounding room/control-channel
      // handles a closed bulk channel as its own failure trigger.
    }
  }
}

// --- Receiver ------------------------------------------------------------

const QUIET_PERIOD_MS = 500;
const PROGRESS_INTERVAL_MS = 250;
// Margin over the sender's own ramp-up + measured budget: covers
// negotiation/scheduling jitter so the receiver's own hard deadline is
// never the thing that cuts off a well-behaved sender.
const HARD_DEADLINE_MARGIN_MS = 5_000;

export interface ReceiverSnapshot {
  elapsedMs: number;
  bytes: number;
  chunksSeen: number;
  highestSeqPlusOne: number;
}

export interface SealedMeasurement {
  bytes: number;
  durationMs: number;
  chunksSeen: number;
  chunksExpected: number;
}

export type ReceiverCloseReason = "end-marker" | "quiet-period" | "hard-deadline";

export interface BulkReceiverOptions {
  runId: string;
  stageId: StageId;
  maxDurationMs: number;
  rampUpMs?: number;
  onProgress?: (snapshot: ReceiverSnapshot) => void;
  /** The receive window closed (marker, quiet period, or hard deadline).
   * Not yet a sealed result — that needs the sender's reliable
   * `sentMeasuredChunks`, supplied later via `finalize`. */
  onWindowClosed?: (reason: ReceiverCloseReason) => void;
}

/** Counts inbound `measured` chunks matching this stage's `runId`/`stageId`
 * and tracks the receive window's real extent, ending it on whichever of
 * the end marker, a quiet period, or a hard deadline comes first — but
 * measuring `durationMs` to the last counted chunk's arrival, not to
 * whichever of those fired (4.1 design notes). */
export class BulkReceiver {
  private readonly opts: Required<Omit<BulkReceiverOptions, "onProgress" | "onWindowClosed">> &
    Pick<BulkReceiverOptions, "onProgress" | "onWindowClosed">;

  private readonly seqBytes = new Map<number, number>();
  private highestSeqPlusOne = 0;
  private firstChunkAt: number | null = null;
  private lastActivityAt: number | null = null;
  private windowDurationMs = 0;

  private armed = false;
  private closed = false;
  private lastProgressAt = -Infinity;

  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  private hardDeadlineTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: BulkReceiverOptions) {
    this.opts = { rampUpMs: RAMP_UP_MS, onProgress: opts.onProgress, onWindowClosed: opts.onWindowClosed, ...opts };
  }

  /** Starts the hard-deadline timer. Call once this stage is armed —
   * "counters reset, receiver ready" — before the sender's `stage-start`
   * can possibly arrive. */
  arm(): void {
    if (this.armed) return;
    this.armed = true;
    const hardDeadlineMs = this.opts.rampUpMs + this.opts.maxDurationMs + HARD_DEADLINE_MARGIN_MS;
    this.hardDeadlineTimer = setTimeout(() => this.closeWindow("hard-deadline"), hardDeadlineMs);
  }

  handleFrame(frame: BulkFrame): void {
    if (this.closed) return;
    if (frame.runId !== this.opts.runId || frame.stageId !== this.opts.stageId) return;

    if (frame.kind === "end") {
      this.closeWindow("end-marker");
      return;
    }
    if (frame.kind !== "measured") return; // ramp-up chunks are never counted

    const now = Date.now();
    if (!this.seqBytes.has(frame.seq)) {
      this.seqBytes.set(frame.seq, frame.data.byteLength);
      if (frame.seq + 1 > this.highestSeqPlusOne) this.highestSeqPlusOne = frame.seq + 1;
    }
    if (this.firstChunkAt === null) this.firstChunkAt = now;
    this.lastActivityAt = now;
    this.resetQuietTimer();
    this.maybeEmitProgress(now);
  }

  /** Best-effort live snapshot; the sealed result is `finalize`'s alone. */
  snapshot(): ReceiverSnapshot {
    return {
      elapsedMs: this.currentDurationMs(),
      bytes: this.totalBytes(),
      chunksSeen: this.seqBytes.size,
      highestSeqPlusOne: this.highestSeqPlusOne,
    };
  }

  /** Discards out-of-range sequence numbers and produces the raw counts a
   * sealed `stage-result` carries — never `highestSeen + 1`. Returns `null`
   * per 4.1's rule ("`chunksExpected` must be greater than zero") when the
   * sender's reliable total is unusable; the stage then produces no edge.
   * Callers are expected to wait for `onWindowClosed` first (the window
   * routinely closes before the reliable total arrives); this freezes the
   * window itself only as a defensive fallback and never re-emits
   * `onWindowClosed` for it. */
  finalize(sentMeasuredChunks: number): SealedMeasurement | null {
    this.freezeWindow();
    if (!Number.isInteger(sentMeasuredChunks) || sentMeasuredChunks <= 0) return null;

    let bytes = 0;
    let chunksSeen = 0;
    for (const [seq, len] of this.seqBytes) {
      if (seq >= 0 && seq < sentMeasuredChunks) {
        bytes += len;
        chunksSeen++;
      }
    }
    return { bytes, durationMs: this.windowDurationMs, chunksSeen, chunksExpected: sentMeasuredChunks };
  }

  stop(): void {
    this.clearTimers();
    this.closed = true;
  }

  private totalBytes(): number {
    let sum = 0;
    for (const len of this.seqBytes.values()) sum += len;
    return sum;
  }

  private currentDurationMs(): number {
    if (this.firstChunkAt === null) return 0;
    const end = this.closed ? this.lastActivityAt! : Date.now();
    return end - this.firstChunkAt;
  }

  private resetQuietTimer(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => this.closeWindow("quiet-period"), QUIET_PERIOD_MS);
  }

  private maybeEmitProgress(now: number): void {
    if (!this.opts.onProgress) return;
    if (now - this.lastProgressAt < PROGRESS_INTERVAL_MS) return;
    this.lastProgressAt = now;
    this.opts.onProgress(this.snapshot());
  }

  private closeWindow(reason: ReceiverCloseReason): void {
    if (this.closed) return;
    this.freezeWindow();
    this.opts.onWindowClosed?.(reason);
  }

  /** The window-ending math shared by every close path (4.1 design notes):
   * measure `durationMs` to the last counted chunk's arrival, not to
   * whichever trigger fired, and emit exactly one final progress update.
   * Idempotent — a later close path (or `finalize`) never re-freezes it. */
  private freezeWindow(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    this.windowDurationMs =
      this.firstChunkAt !== null && this.lastActivityAt !== null
        ? this.lastActivityAt - this.firstChunkAt
        : 0;
    this.opts.onProgress?.(this.snapshot());
  }

  private clearTimers(): void {
    if (this.quietTimer) {
      clearTimeout(this.quietTimer);
      this.quietTimer = null;
    }
    if (this.hardDeadlineTimer) {
      clearTimeout(this.hardDeadlineTimer);
      this.hardDeadlineTimer = null;
    }
  }
}
