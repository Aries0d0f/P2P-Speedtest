/**
 * Symmetric ping/pong latency measurement over the control channel (3.1,
 * 3.2). Phase 2 creates the channel; this module owns everything that runs
 * over it from here on, plus the two-sided `channel-ready` barrier that
 * gates the first ping.
 *
 * Both peers run the identical loop concurrently — send pings, echo pongs,
 * compute RTT from their own clock only — so there is no "who samples"
 * role and clock skew can never be mistaken for latency (03-latency
 * design notes).
 */

// Ship exactly this vocabulary: the four message types this phase
// implements, plus every name Phase 4 reserves. A union with fewer names
// would have to be widened by the phase it was meant to serve; anything not
// in this list is rejected outright by `decodeLatencyMessage` rather than
// silently accepted.
const CONTROL_MESSAGE_TYPES = [
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

export interface Sample {
  seq: number;
  rttMs: number;
}

export interface Aggregate {
  rttMs: number;
  jitterMs: number;
}

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

/**
 * The shared aggregation rule (3.2): median RTT and mean-absolute-difference
 * jitter over a window of samples in arrival order. A pure function over
 * whatever window the caller collected — Phase 4 reuses this exact rule per
 * stage, not just for the idle baseline here. Fewer than MIN_SAMPLES has no
 * meaningful median or jitter and returns `null` rather than a distorted
 * number that would be misread as a real measurement.
 */
export function aggregateSamples(samples: readonly Sample[]): Aggregate | null {
  if (samples.length < MIN_SAMPLES) return null;
  const rtts = samples.map((s) => s.rttMs);
  return { rttMs: median(rtts), jitterMs: meanAbsoluteDifference(rtts) };
}

// --- Wire messages ----------------------------------------------------------

export interface ChannelReadyMessage {
  runId: string;
  type: "channel-ready";
  payload: Record<string, never>;
}
export interface PingMessage {
  runId: string;
  type: "ping";
  seq: number;
  payload: Record<string, never>;
}
export interface PongMessage {
  runId: string;
  type: "pong";
  seq: number;
  payload: Record<string, never>;
}
export interface LatencyReadyMessage {
  runId: string;
  type: "latency-ready";
  payload: { aggregate: Aggregate | null };
}

export type LatencyMessage =
  | ChannelReadyMessage
  | PingMessage
  | PongMessage
  | LatencyReadyMessage;

interface RawMessage {
  runId?: unknown;
  type?: unknown;
  seq?: unknown;
  payload?: unknown;
}

function isKnownControlType(value: unknown): value is ControlMessageType {
  return (
    typeof value === "string" && (CONTROL_MESSAGE_TYPES as readonly string[]).includes(value)
  );
}

/** Returns `null` for a malformed message, a stale/foreign `runId`, a type
 * outside the whole control vocabulary, or a known type this phase doesn't
 * own (`peer-profile`, or one of Phase 4's reserved names) — the caller
 * never has to trust what an untrusted peer sent. */
function extractAggregate(payload: unknown): Aggregate | null | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const value = payload as Record<string, unknown>;
  if (value.aggregate === null) return null;
  const agg = value.aggregate;
  if (typeof agg !== "object" || agg === null) return undefined;
  const a = agg as Record<string, unknown>;
  if (
    typeof a.rttMs !== "number" ||
    typeof a.jitterMs !== "number" ||
    !Number.isFinite(a.rttMs) ||
    !Number.isFinite(a.jitterMs)
  ) {
    return undefined;
  }
  return { rttMs: a.rttMs, jitterMs: a.jitterMs };
}

export function decodeLatencyMessage(data: unknown, runId: string): LatencyMessage | null {
  if (typeof data !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const value = parsed as RawMessage;

  if (!isKnownControlType(value.type)) return null;
  if (value.runId !== runId) return null;

  switch (value.type) {
    case "channel-ready":
      return { runId, type: "channel-ready", payload: {} };
    case "ping":
    case "pong": {
      if (typeof value.seq !== "number" || !Number.isInteger(value.seq) || value.seq < 0) {
        return null;
      }
      return { runId, type: value.type, seq: value.seq, payload: {} };
    }
    case "latency-ready": {
      const aggregate = extractAggregate(value.payload);
      if (aggregate === undefined) return null;
      return { runId, type: "latency-ready", payload: { aggregate } };
    }
    default:
      return null;
  }
}

// --- Session -----------------------------------------------------------------

export interface LiveLatency {
  rttMs: number;
  jitterMs: number | null;
  sampleCount: number;
}

export type LatencyTerminalReason = "latency-ready-timeout" | "control-closed" | "run-ended";

/** The one immutable handoff this phase exposes to Phase 4's terminal
 * accumulator (3.2 design notes). "ready" is the normal path: both sides
 * finalized and exchanged `latency-ready`. "terminal" covers a missing peer
 * `latency-ready`, the control channel closing, or a post-start
 * `run-ended` — each freezes whatever samples already arrived rather than
 * hanging or discarding a partial result. */
export type LatencyHandoff =
  | { kind: "ready"; baseline: Aggregate | null }
  | {
      kind: "terminal";
      reason: LatencyTerminalReason;
      baseline: Aggregate | null;
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

  private localAggregate: Aggregate | null | undefined;
  private peerAggregate: Aggregate | null | undefined;

  constructor(opts: LatencySessionOptions) {
    this.runId = opts.runId;
    this.sendRaw = opts.send;
    this.callbacks = opts.callbacks ?? {};
  }

  /** Call once this side has sent its required initial `peer-profile` and
   * validated the peer's — the first half of the two-sided barrier (3-2.6).
   * Sampling starts only once the peer's own `channel-ready` has also been
   * received; both sides decide independently from the same two facts, so
   * no coordinator is needed. */
  sendChannelReady(): void {
    if (this.sentChannelReady) return;
    this.sentChannelReady = true;
    this.send({ runId: this.runId, type: "channel-ready", payload: {} });
    this.maybeStart();
  }

  /** Dispatches an already-decoded message from `decodeLatencyMessage`. */
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

  /** Post-start failure path (3.2): a missing peer `latency-ready`, the
   * control channel closing, or `run-ended` after sampling began. Snapshots
   * whatever samples already arrived before anything is cleared, and never
   * delivers more than one handoff — idempotent by construction, since
   * `state` only ever leaves "sampling"/"awaiting-peer" once. Before
   * sampling starts (`state === "idle"`) this is a no-op: no measurement
   * boundary has been crossed yet, and Phase 2's pre-measurement path
   * writes nothing regardless. */
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
      this.sendRaw(JSON.stringify(msg));
    } catch {
      // Channel already closed — the close/terminal path handles this.
    }
  }
}
