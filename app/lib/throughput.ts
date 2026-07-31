/**
 * Bulk transfer over the unordered, non-retransmitting `bulk` channels (4.1).
 *
 * Transport-topology-agnostic by design: it knows only the `BulkChannel`
 * interface, never how many connections back the channels it is given. Every
 * channel shares one `runId`/`stageId`/measured-sequence space, so a receiver
 * never needs to know which one delivered a chunk.
 */

import { bytesToUuid, uuidToBytes } from "./uuid-bytes";
import { isStageId, type StageId } from "~/model/stage.model";
import {
  BULK_FRAME_HEADER_BYTES,
  KIND_CODES,
  KIND_NAMES,
  type BulkChannel,
  type BulkFrame,
  type BulkFrameKind,
} from "~/model/bulk-frame.model";
import type { MeasurementProgress, SealedMeasurement } from "~/model/measurement.model";

/** Throws on a shape the sender should never produce, so a bug can't
 * silently emit a frame `parseBulkFrame` would reject on the other side. */
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

/** Warm-up before measurement, so congestion-window effects don't distort
 * the window. Ramp-up chunks never consume the measured sequence space. */
export const RAMP_UP_MS = 1500;

// An *aggregate* target across every channel, not per channel: a per-channel
// floor would multiply queued memory by channel count for no benefit. Too
// small a threshold makes the JS/event-loop round trip the bottleneck rather
// than the network. Shapes nothing measured — that comes from `test-config`.
const AGGREGATE_BUFFERED_LOW_THRESHOLD_BYTES = 8 * 1024 * 1024; // 8 MiB total
const BUFFERED_LOW_THRESHOLD_MIN_CHUNKS_PER_CHANNEL = 8;

export interface BulkSenderOptions {
  /** One or more channels to fan the measured stream across (04-throughput
   * revision: parallel bulk channels). A single-entry array is the
   * one-channel case — there's nothing special about it. */
  channels: BulkChannel[];
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

/** Event-driven send loop against `bufferedAmount`/`bufferedamountlow`.
 * Every channel draws from one shared seq/byte counter, so a channel that
 * drains faster naturally pulls more of the stream. */
export class BulkSender {
  private readonly opts: Required<Omit<BulkSenderOptions, "onComplete">> &
    Pick<BulkSenderOptions, "onComplete">;
  // One frame buffer, mutated (seq + kind byte) and resent. Safe to share
  // across channels: `send(ArrayBuffer)` copies synchronously before
  // returning and JS is single-threaded, so no two sends overlap on it.
  private readonly frameBuffer: ArrayBuffer;
  private readonly frameBytes: Uint8Array;
  private readonly frameView: DataView;

  private phase: SenderPhase = "ramp-up";
  private nextSeq = 0;
  private bytesSent = 0;
  private rampUpEndsAt = 0;
  private measuredDeadlineAt = 0;
  private started = false;
  private stopped = false;

  private readonly onBufferedLowByChannel: Array<() => void>;

  constructor(opts: BulkSenderOptions) {
    if (opts.channels.length === 0) {
      throw new RangeError("BulkSender: at least one channel is required");
    }
    this.opts = { rampUpMs: RAMP_UP_MS, onComplete: opts.onComplete, ...opts };

    this.frameBuffer = new ArrayBuffer(BULK_FRAME_HEADER_BYTES + this.opts.chunkBytes);
    this.frameBytes = new Uint8Array(this.frameBuffer);
    this.frameView = new DataView(this.frameBuffer);
    // runId and stageId never change for this sender's lifetime — written
    // once here. `seq` and the kind byte are the only per-send mutations.
    this.frameBytes.set(uuidToBytes(this.opts.runId), 0);
    this.frameBytes[16] = this.opts.stageId;
    // The payload region (byte 22 onward) stays zero-filled; its content
    // is never inspected by either side, only its length.

    this.onBufferedLowByChannel = this.opts.channels.map(() => () => this.pump());
  }

  get sentMeasuredChunks(): number {
    return this.nextSeq;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const now = Date.now();
    this.rampUpEndsAt = now + this.opts.rampUpMs;
    const threshold = Math.max(
      this.opts.chunkBytes * BUFFERED_LOW_THRESHOLD_MIN_CHUNKS_PER_CHANNEL,
      Math.floor(AGGREGATE_BUFFERED_LOW_THRESHOLD_BYTES / this.opts.channels.length),
    );
    this.opts.channels.forEach((channel, i) => {
      channel.bufferedAmountLowThreshold = threshold;
      channel.addEventListener("bufferedamountlow", this.onBufferedLowByChannel[i]);
    });
    this.pump();
  }

  /** Stops the loop without sending the `end` marker — for an aborted run,
   * where no valid stage result will ever be assembled from this stage
   * anyway. Idempotent. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.opts.channels.forEach((channel, i) =>
      channel.removeEventListener("bufferedamountlow", this.onBufferedLowByChannel[i]),
    );
  }

  /** One chunk at a time across every channel with room, not one channel to
   * its threshold before the next: channels on one `RTCPeerConnection` share
   * an SCTP association, so a large queued lead really does serialize them. */
  private pump(): void {
    if (this.stopped || this.phase === "done") return;
    let sentAny = true;
    while (sentAny) {
      sentAny = false;
      for (const channel of this.opts.channels) {
        if (channel.bufferedAmount >= channel.bufferedAmountLowThreshold) continue;
        if (!this.sendNext(channel)) return; // phase finished mid-pass
        sentAny = true;
      }
    }
  }

  /** Sends exactly one frame on `channel` and returns whether the loop
   * should keep going. Ramp-up falls through into measured immediately
   * once its timer elapses, in the same backpressure-gated pass. */
  private sendNext(channel: BulkChannel): boolean {
    const now = Date.now();

    if (this.phase === "ramp-up") {
      if (now >= this.rampUpEndsAt) {
        this.phase = "measured";
        this.measuredDeadlineAt = now + this.opts.maxDurationMs;
        return this.sendNext(channel);
      }
      this.sendFrame(channel, 0, "ramp-up");
      return true;
    }

    // measured
    if (now >= this.measuredDeadlineAt || this.bytesSent >= this.opts.maxBytes) {
      this.finish();
      return false;
    }
    const seq = this.nextSeq++;
    this.sendFrame(channel, seq, "measured");
    this.bytesSent += this.opts.chunkBytes;
    return true;
  }

  private finish(): void {
    this.phase = "done";
    const endFrame = encodeBulkFrame({
      runId: this.opts.runId,
      stageId: this.opts.stageId,
      seq: this.nextSeq,
      kind: "end",
      data: new Uint8Array(0),
    });
    // The marker is itself unreliable, so it goes out on every channel —
    // redundancy across all of them meaningfully raises the odds at least
    // one arrives, for the cost of a few 22-byte frames.
    for (const channel of this.opts.channels) this.sendRaw(channel, endFrame);
    this.stop();
    this.opts.onComplete?.(this.nextSeq);
  }

  /** Writes `seq`/kind into the reused frame buffer and sends it — the hot
   * path for every ramp-up/measured chunk. */
  private sendFrame(channel: BulkChannel, seq: number, kind: BulkFrameKind): void {
    this.frameView.setUint32(17, seq, false);
    this.frameBytes[21] = KIND_CODES[kind];
    this.sendRaw(channel, this.frameBuffer);
  }

  private sendRaw(channel: BulkChannel, buffer: ArrayBuffer): void {
    try {
      channel.send(buffer);
    } catch {
      // Channel already closed — the surrounding room/control-channel
      // handles a closed bulk channel as its own failure trigger.
    }
  }
}

// --- Receiver ------------------------------------------------------------

// Exported (rather than kept module-private) so tests reference these
// exact values instead of duplicating them as magic numbers that silently
// drift out of sync whenever the constants here are retuned.
export const QUIET_PERIOD_MS = 1000;
export const PROGRESS_INTERVAL_MS = 50;
// Well under QUIET_PERIOD_MS, so detection stays as tight without a timer
// reschedule on every single chunk.
const QUIET_TIMER_RESET_THROTTLE_MS = 100;
// Margin over the sender's own ramp-up + measured budget: covers
// negotiation/scheduling jitter so the receiver's own hard deadline is
// never the thing that cuts off a well-behaved sender.
export const HARD_DEADLINE_MARGIN_MS = 15_000;

export type ReceiverCloseReason = "end-marker" | "quiet-period" | "hard-deadline";

export interface BulkReceiverOptions {
  runId: string;
  stageId: StageId;
  maxDurationMs: number;
  rampUpMs?: number;
  onProgress?: (snapshot: MeasurementProgress) => void;
  /** The receive window closed (marker, quiet period, or hard deadline).
   * Not yet a sealed result — that needs the sender's reliable
   * `sentMeasuredChunks`, supplied later via `finalize`. */
  onWindowClosed?: (reason: ReceiverCloseReason) => void;
}

/** Ends the window on whichever of the end marker, a quiet period, or a hard
 * deadline comes first — but measures `durationMs` to the last counted
 * chunk's arrival, not to whichever of those fired. */
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
  private lastQuietTimerResetAt = -Infinity;

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
    this.resetQuietTimer(now);
    this.maybeEmitProgress(now);
  }

  /** Best-effort live snapshot; the sealed result is `finalize`'s alone. */
  snapshot(): MeasurementProgress {
    return {
      elapsedMs: this.currentDurationMs(),
      bytes: this.totalBytes(),
      chunksSeen: this.seqBytes.size,
      highestSeqPlusOne: this.highestSeqPlusOne,
    };
  }

  /** `chunksExpected` is the sender's reliable total, never `highestSeen + 1`;
   * `null` when that total is unusable, and the stage then produces no edge.
   * Freezing here is a defensive fallback — callers wait for
   * `onWindowClosed` — and never re-emits it. */
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

  /** Throttled to avoid a timer reschedule per chunk at thousands/sec.
   * `lastActivityAt` is still updated on every frame, so `durationMs` stays
   * exact even though the reschedule is not. */
  private resetQuietTimer(now: number): void {
    if (now - this.lastQuietTimerResetAt < QUIET_TIMER_RESET_THROTTLE_MS) return;
    this.lastQuietTimerResetAt = now;
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

  /** Shared by every close path: `durationMs` runs to the last counted
   * chunk's arrival, not to whichever trigger fired. Idempotent. */
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
