/**
 * Symmetric ping/pong latency over the control channel (3.1, 3.2), plus the
 * two-sided `channel-ready` barrier that gates the first ping.
 *
 * Both peers run the identical loop concurrently and compute RTT from their
 * own clock only, so there is no "who samples" role and clock skew can never
 * be mistaken for latency.
 */

import type {
  LatencyAggregate,
  LiveLatency,
  Sample,
} from "~/model/measurement.model";
import type { LatencyMessage } from "~/model/control-message.model";
import { encodeControlMessage } from "./control-message";

// --- Bounded sampling window (3.2 design table) ----------------------------

const SEND_CADENCE_MS = 200; // one ping / 200ms -> 10 samples in ~2s
const PING_TIMEOUT_MS = 2_000; // a pong later than this is retired, not counted
const WINDOW_DEADLINE_MS = 5_000; // hard stop regardless of how many replies arrived
const TARGET_SAMPLES = 10; // normal completion
const MIN_SAMPLES = 3; // fewest yielding a meaningful median and two differences for jitter

// Both peers start the two-sided barrier at roughly the same time, so a
// well-behaved peer's own window closes and its `latency-ready` arrives
// within about one window's length of ours; this adds margin on top of
// WINDOW_DEADLINE_MS rather than reusing it exactly.
const PEER_READY_TIMEOUT_MS = 6_000;

// --- Aggregation ------------------------------------------------------------

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Mean absolute difference between consecutive RTTs — chosen over variance
// because it's the definition consumer speedtest tools use, so the jitter
// number this app reports matches what users already expect elsewhere.
function meanAbsoluteDifference(values: readonly number[]): number {
  let sum = 0;
  for (let i = 1; i < values.length; i++) sum += Math.abs(values[i] - values[i - 1]);
  return sum / (values.length - 1);
}

/** Median RTT and mean-absolute-difference jitter, in arrival order. Fewer
 * than MIN_SAMPLES returns `null` rather than a distorted number that would
 * be misread as a real measurement. Reused per stage, not just here. */
export function aggregateSamples(samples: readonly Sample[]): LatencyAggregate | null {
  if (samples.length < MIN_SAMPLES) return null;
  const rtts = samples.map((s) => s.rttMs);
  return { rttMs: median(rtts), jitterMs: meanAbsoluteDifference(rtts) };
}

// --- Session -----------------------------------------------------------------

export type LatencyTerminalReason = "latency-ready-timeout" | "control-closed" | "run-ended";

/** "ready" is the normal path: both sides exchanged `latency-ready`.
 * "terminal" covers a missing peer `latency-ready`, the control channel
 * closing, or a post-start `run-ended` — each freezes whatever samples
 * arrived rather than hanging or discarding a partial result. */
export type LatencyHandoff =
  | { kind: "ready"; baseline: LatencyAggregate | null }
  | {
      kind: "terminal";
      reason: LatencyTerminalReason;
      baseline: LatencyAggregate | null;
      sampleCount: number;
    };

export interface LatencySessionCallbacks {
  /** Fires once the two-sided `channel-ready` barrier resolves and sampling
   * actually begins — the signal to leave `paired` for `testing` (3.3). */
  onSamplingStarted?: () => void;
  onLive?: (live: LiveLatency) => void;
  onHandoff?: (handoff: LatencyHandoff) => void;
}

export interface LatencySessionOptions {
  runId: string;
  /** Writes one already-serialized message to the control channel. */
  send: (raw: string) => void;
  callbacks?: LatencySessionCallbacks;
}

type SessionState = "idle" | "sampling" | "awaiting-peer" | "done" | "terminal";

interface PendingPing {
  sentAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export class LatencySession {
  private readonly runId: string;
  private readonly sendRaw: (raw: string) => void;
  private readonly callbacks: LatencySessionCallbacks;

  private state: SessionState = "idle";
  private sentChannelReady = false;
  private receivedChannelReady = false;

  private nextSeq = 0;
  private readonly pending = new Map<number, PendingPing>();
  private samples: Sample[] = [];

  private sendTimer: ReturnType<typeof setInterval> | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private peerReadyTimer: ReturnType<typeof setTimeout> | null = null;

  private localAggregate: LatencyAggregate | null | undefined;
  private peerAggregate: LatencyAggregate | null | undefined;

  constructor(opts: LatencySessionOptions) {
    this.runId = opts.runId;
    this.sendRaw = opts.send;
    this.callbacks = opts.callbacks ?? {};
  }

  /** The first half of the two-sided barrier: call once this side has sent
   * its initial `peer-profile` and validated the peer's. Both sides decide
   * independently from the same two facts, so no coordinator is needed. */
  sendChannelReady(): void {
    if (this.sentChannelReady) return;
    this.sentChannelReady = true;
    this.send({ runId: this.runId, type: "channel-ready", payload: {} });
    this.maybeStart();
  }

  /** Dispatches an already-decoded message. */
  handleMessage(msg: LatencyMessage): void {
    switch (msg.type) {
      case "channel-ready":
        this.receivedChannelReady = true;
        this.maybeStart();
        return;
      case "ping":
        // Echoed regardless of local session state: the peer can only be
        // sending pings once its own barrier resolved, which (by the same
        // two facts) means ours has too — see design notes. Echoing is
        // cheap and keeps the peer's window from starving on our account.
        this.send({ runId: this.runId, type: "pong", seq: msg.seq, payload: {} });
        return;
      case "pong":
        this.handlePong(msg.seq);
        return;
      case "latency-ready":
        this.peerAggregate = msg.payload.aggregate;
        this.checkCompletion();
        return;
    }
  }

  /** Snapshots whatever samples arrived before anything is cleared, and
   * never delivers more than one handoff — `state` only leaves
   * "sampling"/"awaiting-peer" once. A no-op while still `idle`: no
   * measurement boundary has been crossed yet. */
  freezeForTerminal(reason: LatencyTerminalReason): void {
    if (this.state === "idle" || this.state === "done" || this.state === "terminal") return;
    this.state = "terminal";
    this.clearSendingTimers();
    this.clearPeerReadyTimer();
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();

    const snapshot = [...this.samples];
    const sampleCount = snapshot.length;
    const baseline = sampleCount >= MIN_SAMPLES ? aggregateSamples(snapshot) : null;
    this.callbacks.onHandoff?.({ kind: "terminal", reason, baseline, sampleCount });
  }

  /** Clears all live state back to a fresh `idle` session. Callers must
   * wait for a terminal handoff to be copied first (3.2) — this never
   * fires a handoff itself, so it must not be the only path to clearing
   * state after sampling began. */
  reset(): void {
    this.clearSendingTimers();
    this.clearPeerReadyTimer();
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
    this.samples = [];
    this.nextSeq = 0;
    this.sentChannelReady = false;
    this.receivedChannelReady = false;
    this.localAggregate = undefined;
    this.peerAggregate = undefined;
    this.state = "idle";
  }

  private maybeStart(): void {
    if (this.state !== "idle") return;
    if (!this.sentChannelReady || !this.receivedChannelReady) return;
    this.state = "sampling";
    this.callbacks.onSamplingStarted?.();
    this.sendPing();
    this.sendTimer = setInterval(() => this.sendPing(), SEND_CADENCE_MS);
    this.deadlineTimer = setTimeout(() => this.closeWindow(), WINDOW_DEADLINE_MS);
  }

  private sendPing(): void {
    if (this.state !== "sampling") return;
    const seq = this.nextSeq++;
    const sentAt = Date.now();
    const timer = setTimeout(() => {
      this.pending.delete(seq);
    }, PING_TIMEOUT_MS);
    this.pending.set(seq, { sentAt, timer });
    this.send({ runId: this.runId, type: "ping", seq, payload: {} });
  }

  private handlePong(seq: number): void {
    // The window already closed — a late pong is discarded, not folded
    // back in; a straggling multi-second round trip would distort the
    // median far more than the missing sample does.
    if (this.state !== "sampling") return;
    const entry = this.pending.get(seq);
    if (!entry) return; // unmatched, duplicate, or already-retired seq
    this.pending.delete(seq);
    clearTimeout(entry.timer);
    const rttMs = Date.now() - entry.sentAt;
    this.samples.push({ seq, rttMs });
    this.emitLive();
    if (this.samples.length >= TARGET_SAMPLES) this.closeWindow();
  }

  private emitLive(): void {
    if (!this.callbacks.onLive) return;
    const rtts = this.samples.map((s) => s.rttMs);
    this.callbacks.onLive({
      rttMs: median(rtts),
      jitterMs: this.samples.length >= 2 ? meanAbsoluteDifference(rtts) : null,
      sampleCount: this.samples.length,
    });
  }

  private closeWindow(): void {
    if (this.state !== "sampling") return;
    this.state = "awaiting-peer";
    this.clearSendingTimers();
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();

    this.localAggregate = aggregateSamples(this.samples);
    this.send({
      runId: this.runId,
      type: "latency-ready",
      payload: { aggregate: this.localAggregate },
    });
    this.peerReadyTimer = setTimeout(
      () => this.freezeForTerminal("latency-ready-timeout"),
      PEER_READY_TIMEOUT_MS,
    );
    this.checkCompletion();
  }

  private checkCompletion(): void {
    if (this.state !== "awaiting-peer") return;
    if (this.localAggregate === undefined || this.peerAggregate === undefined) return;
    this.state = "done";
    this.clearPeerReadyTimer();
    this.callbacks.onHandoff?.({ kind: "ready", baseline: this.localAggregate });
  }

  private clearSendingTimers(): void {
    if (this.sendTimer) {
      clearInterval(this.sendTimer);
      this.sendTimer = null;
    }
    if (this.deadlineTimer) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
    }
  }

  private clearPeerReadyTimer(): void {
    if (this.peerReadyTimer) {
      clearTimeout(this.peerReadyTimer);
      this.peerReadyTimer = null;
    }
  }

  private send(msg: LatencyMessage): void {
    try {
      this.sendRaw(encodeControlMessage(msg));
    } catch {
      // Channel already closed — the close/terminal path handles this.
    }
  }
}
