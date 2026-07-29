/**
 * Stage sequencing and terminal finalization (4.2, 4.4). Extends Phase 3's
 * `latency.ts` control vocabulary — `ping`/`pong` keep running throughout
 * every stage, and this module segments that same RTT stream into one
 * aggregate per stage window using Phase 3's exact `aggregateSamples` rule.
 *
 * Two cooperating pieces:
 * - `StageOrchestrator` drives the three-stage handshake (4.2): transport
 *   barriers (`stage-prepare`/`armed`/`start`/`complete`) and bank barriers
 *   (`stage-result`/`stage-result-ack`), wrapping `throughput.ts`'s
 *   sender/receiver per stage.
 * - `TerminalController` is the one run-scoped finalization FSM (4.4):
 *   `test-abort`/`result-share` exchange, then assembly, validation,
 *   hashing, and the local save attempt.
 */

import { aggregateSamples, type Aggregate, type Sample } from "./latency";
import type { TestConfigPayload } from "./protocol";
import {
  BulkReceiver,
  BulkSender,
  RAMP_UP_MS,
  type BulkChannel,
  type BulkFrame,
} from "./throughput";
import {
  DOWNLOAD,
  DUPLEX,
  STAGE_ORDER,
  UPLOAD,
  allEdgeKeys,
  edgeKey,
  isReceiver,
  isSender,
  isStageId,
  isValidMeasurement,
  otherSlot,
  type Measurement,
  type Slot,
  type StageBankEntry,
  type StageId,
} from "./stage";
import type { ConnectionType } from "./webrtc";
import {
  assembleResult,
  buildMetadata,
  saveResult,
  type P2PSpeedtestResult,
  type ResultStatus,
} from "./results";
import { validateData, type ValidationResult } from "./result-validate";
import { computeResultHash } from "./result-hash";
import type { ReceivedPeerProfile } from "./peer-profile";

// --- Wire messages (4.2, 4.4) ----------------------------------------------
//
// The full control vocabulary this phase reserves (latency.ts's
// `CONTROL_MESSAGE_TYPES`) minus the four Phase 3 already owns.

export interface StagePrepareMessage {
  runId: string;
  type: "stage-prepare";
  stageId: StageId;
  payload: Record<string, never>;
}
export interface StageArmedMessage {
  runId: string;
  type: "stage-armed";
  stageId: StageId;
  payload: Record<string, never>;
}
export interface StageStartMessage {
  runId: string;
  type: "stage-start";
  stageId: StageId;
  payload: Record<string, never>;
}
export interface StageCompleteMessage {
  runId: string;
  type: "stage-complete";
  stageId: StageId;
  payload: { sentMeasuredChunks?: number };
}
export interface MeasurementProgressMessage {
  runId: string;
  type: "measurement-progress";
  stageId: StageId;
  receiverSlot: Slot;
  progressSeq: number;
  payload: { elapsedMs: number; bytes: number; chunksSeen: number; highestSeqPlusOne: number };
}
export interface StageResultMessage {
  runId: string;
  type: "stage-result";
  stageId: StageId;
  receiverSlot: Slot;
  payload: { measurement: Measurement };
}
export interface StageResultAckMessage {
  runId: string;
  type: "stage-result-ack";
  stageId: StageId;
  receiverSlot: Slot;
  payload: Record<string, never>;
}
export interface TestAbortMessage {
  runId: string;
  type: "test-abort";
  payload: { status: "FAILED" | "CANCELED"; reason: string };
}
export interface ResultSharePayloadSucceed {
  status: "SUCCEED";
  directional: Measurement;
  duplex: Measurement;
  via: ConnectionType;
}
export interface ResultSharePayloadOther {
  status: "FAILED" | "CANCELED";
  reason: string;
  directional?: Measurement;
  duplex?: Measurement;
  via?: ConnectionType;
}
export type ResultSharePayload = ResultSharePayloadSucceed | ResultSharePayloadOther;
export interface ResultShareMessage {
  runId: string;
  type: "result-share";
  payload: ResultSharePayload;
}

export type StageMessage =
  | StagePrepareMessage
  | StageArmedMessage
  | StageStartMessage
  | StageCompleteMessage
  | MeasurementProgressMessage
  | StageResultMessage
  | StageResultAckMessage
  | TestAbortMessage
  | ResultShareMessage;

const STAGE_MESSAGE_TYPES = new Set<string>([
  "stage-prepare",
  "stage-armed",
  "stage-start",
  "stage-complete",
  "measurement-progress",
  "stage-result",
  "stage-result-ack",
  "test-abort",
  "result-share",
]);

function isSlot(value: unknown): value is Slot {
  return value === 0 || value === 1;
}
function isConnectionType(value: unknown): value is ConnectionType {
  return value === "DIRECT" || value === "RELAY" || value === "UNKNOWN";
}
function isFiniteNonNegNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Parses and run-scopes one Phase 4 control message. Returns `null` for
 * anything malformed, for a message this phase doesn't own (Phase 3's own
 * four types), for a stale/foreign `runId`, or for a type outside the
 * whole control vocabulary — same contract as `decodeLatencyMessage`. */
export function decodeStageMessage(data: unknown, runId: string): StageMessage | null {
  if (typeof data !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const v = parsed as Record<string, unknown>;
  if (typeof v.type !== "string" || !STAGE_MESSAGE_TYPES.has(v.type)) return null;
  if (v.runId !== runId) return null;

  switch (v.type) {
    case "stage-prepare":
    case "stage-armed":
    case "stage-start": {
      if (!isStageId(v.stageId)) return null;
      return { runId, type: v.type, stageId: v.stageId, payload: {} };
    }
    case "stage-complete": {
      if (!isStageId(v.stageId)) return null;
      if (typeof v.payload !== "object" || v.payload === null) return null;
      const p = v.payload as Record<string, unknown>;
      let sentMeasuredChunks: number | undefined;
      if (p.sentMeasuredChunks !== undefined) {
        if (
          typeof p.sentMeasuredChunks !== "number" ||
          !Number.isInteger(p.sentMeasuredChunks) ||
          p.sentMeasuredChunks < 0
        ) {
          return null;
        }
        sentMeasuredChunks = p.sentMeasuredChunks;
      }
      return { runId, type: "stage-complete", stageId: v.stageId, payload: { sentMeasuredChunks } };
    }
    case "measurement-progress": {
      if (!isStageId(v.stageId) || !isSlot(v.receiverSlot)) return null;
      if (typeof v.progressSeq !== "number" || !Number.isInteger(v.progressSeq) || v.progressSeq < 0) {
        return null;
      }
      if (typeof v.payload !== "object" || v.payload === null) return null;
      const p = v.payload as Record<string, unknown>;
      if (
        !isFiniteNonNegNumber(p.elapsedMs) ||
        !isFiniteNonNegNumber(p.bytes) ||
        !isFiniteNonNegNumber(p.chunksSeen) ||
        !isFiniteNonNegNumber(p.highestSeqPlusOne)
      ) {
        return null;
      }
      return {
        runId,
        type: "measurement-progress",
        stageId: v.stageId,
        receiverSlot: v.receiverSlot,
        progressSeq: v.progressSeq,
        payload: {
          elapsedMs: p.elapsedMs,
          bytes: p.bytes,
          chunksSeen: p.chunksSeen,
          highestSeqPlusOne: p.highestSeqPlusOne,
        },
      };
    }
    case "stage-result": {
      if (!isStageId(v.stageId) || !isSlot(v.receiverSlot)) return null;
      if (typeof v.payload !== "object" || v.payload === null) return null;
      const measurement = (v.payload as Record<string, unknown>).measurement;
      if (!isValidMeasurement(measurement)) return null;
      return {
        runId,
        type: "stage-result",
        stageId: v.stageId,
        receiverSlot: v.receiverSlot,
        payload: { measurement },
      };
    }
    case "stage-result-ack": {
      if (!isStageId(v.stageId) || !isSlot(v.receiverSlot)) return null;
      return { runId, type: "stage-result-ack", stageId: v.stageId, receiverSlot: v.receiverSlot, payload: {} };
    }
    case "test-abort": {
      if (typeof v.payload !== "object" || v.payload === null) return null;
      const p = v.payload as Record<string, unknown>;
      if (p.status !== "FAILED" && p.status !== "CANCELED") return null;
      if (typeof p.reason !== "string" || p.reason.length === 0) return null;
      return { runId, type: "test-abort", payload: { status: p.status, reason: p.reason } };
    }
    case "result-share": {
      if (typeof v.payload !== "object" || v.payload === null) return null;
      const p = v.payload as Record<string, unknown>;
      if (p.status === "SUCCEED") {
        if (!isValidMeasurement(p.directional) || !isValidMeasurement(p.duplex) || !isConnectionType(p.via)) {
          return null;
        }
        return {
          runId,
          type: "result-share",
          payload: { status: "SUCCEED", directional: p.directional, duplex: p.duplex, via: p.via },
        };
      }
      if (p.status === "FAILED" || p.status === "CANCELED") {
        if (typeof p.reason !== "string" || p.reason.length === 0) return null;
        const out: ResultSharePayloadOther = { status: p.status, reason: p.reason };
        if (p.directional !== undefined) {
          if (!isValidMeasurement(p.directional)) return null;
          out.directional = p.directional;
        }
        if (p.duplex !== undefined) {
          if (!isValidMeasurement(p.duplex)) return null;
          out.duplex = p.duplex;
        }
        if (p.via !== undefined) {
          if (!isConnectionType(p.via)) return null;
          out.via = p.via;
        }
        return { runId, type: "result-share", payload: out };
      }
      return null;
    }
    default:
      return null;
  }
}

// --- Stage sequencing (4.2) -------------------------------------------------

const PING_CADENCE_MS = 200;
// Generous margin over the sender's own ramp-up + measured budget for
// handshake round trips (prepare/armed/start plus the result/ack pair) —
// distinct from BulkReceiver's own, tighter hard deadline for the receive
// window alone.
const HANDSHAKE_BUFFER_MS = 6_000;

function stageTimeoutMs(testConfig: TestConfigPayload): number {
  return RAMP_UP_MS + testConfig.maxDurationMs + HANDSHAKE_BUFFER_MS;
}

export interface StageProgressSnapshot {
  stageId: StageId;
  receiverSlot: Slot;
  elapsedMs: number;
  bytes: number;
  chunksSeen: number;
  highestSeqPlusOne: number;
}

export interface StageOrchestratorCallbacks {
  onStageStarted?: (stage: StageId) => void;
  onProgress?: (snapshot: StageProgressSnapshot) => void;
  onEdgeBanked?: (entry: StageBankEntry) => void;
  /** Every required edge (2 directional + 2 duplex) is banked locally —
   * the signal to move the room from `testing` to `finalizing` (S8). */
  onStagesDone?: () => void;
  /** A handshake step never completed in time — moves `testing` into its
   * error sub-state (4.2). Already-banked earlier-stage edges remain. */
  onTimeout?: () => void;
}

export interface StageOrchestratorOptions {
  runId: string;
  selfSlot: Slot;
  testConfig: TestConfigPayload;
  /** Writes one already-serialized message to the reliable control channel. */
  send: (raw: string) => void;
  /** Every parallel bulk channel (04-throughput revision) — fanned out to
   * for sending; frames arriving on any of them are handed to
   * `handleBulkFrame` the same way regardless of which one delivered them. */
  bulkChannels: BulkChannel[];
  callbacks?: StageOrchestratorCallbacks;
}

interface StageState {
  stageId: StageId;
  sender: BulkSender | null;
  receiver: BulkReceiver | null;
  neededKeys: string[];
  localArmedSent: boolean;
  peerArmed: boolean;
  started: boolean;
  localSendDone: boolean;
  localReceiveWindowClosed: boolean;
  localStageCompleteSent: boolean;
  remoteStageCompleteReceived: boolean;
  remoteSentMeasuredChunks: number | undefined;
  localResultSent: boolean;
  awaitingAck: Set<string>;
  progressSeq: number;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
}

/** Directional stages have exactly one fixed receiver slot. */
function directionalReceiverSlot(stageId: StageId): Slot {
  return stageId === DOWNLOAD ? 1 : 0;
}

/** Drives the three-stage handshake (4.2). Slot 0 is always the
 * coordinator — the only one that emits `stage-prepare`/`stage-start`;
 * both peers emit their own `stage-armed`/`stage-complete` and, when they
 * hold a receiver role, `stage-result`. */
export class StageOrchestrator {
  private readonly runId: string;
  private readonly selfSlot: Slot;
  private readonly testConfig: TestConfigPayload;
  private readonly sendRaw: (raw: string) => void;
  private readonly bulkChannels: BulkChannel[];
  private readonly callbacks: StageOrchestratorCallbacks;

  private stage: StageState | null = null;
  private readonly bank = new Map<string, StageBankEntry>();
  private stagesDoneFired = false;
  private stopped = false;

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private nextPingSeq = 0;
  private readonly pendingPings = new Map<number, number>();
  private currentLatencySamples: Sample[] = [];
  private readonly lastRemoteProgressSeq = new Map<Slot, number>();

  constructor(opts: StageOrchestratorOptions) {
    this.runId = opts.runId;
    this.selfSlot = opts.selfSlot;
    this.testConfig = opts.testConfig;
    this.sendRaw = opts.send;
    this.bulkChannels = opts.bulkChannels;
    this.callbacks = opts.callbacks ?? {};
  }

  start(): void {
    this.startPingLoop();
    if (this.selfSlot === 0) this.beginStageAsCoordinator(DOWNLOAD);
  }

  handleMessage(msg: StageMessage): void {
    switch (msg.type) {
      case "stage-prepare":
        this.onStagePrepare(msg.stageId);
        return;
      case "stage-armed":
        this.onStageArmed(msg.stageId);
        return;
      case "stage-start":
        this.onStageStart(msg.stageId);
        return;
      case "stage-complete":
        this.onStageComplete(msg.stageId, msg.payload.sentMeasuredChunks);
        return;
      case "measurement-progress":
        this.onRemoteProgress(msg);
        return;
      case "stage-result":
        this.onStageResult(msg.stageId, msg.receiverSlot, msg.payload.measurement);
        return;
      case "stage-result-ack":
        this.onStageResultAck(msg.stageId, msg.receiverSlot);
        return;
      default:
        return; // test-abort / result-share belong to TerminalController
    }
  }

  handleBulkFrame(frame: BulkFrame): void {
    this.stage?.receiver?.handleFrame(frame);
  }

  /** Echo a pong for every ping regardless of stage state — mirrors
   * `LatencySession`'s unconditional echo (3.2), now for the continuous
   * loop that runs the whole testing phase rather than just the idle
   * baseline. */
  handlePing(seq: number): void {
    this.sendRaw(JSON.stringify({ runId: this.runId, type: "pong", seq, payload: {} }));
  }

  handlePong(seq: number): void {
    const sentAt = this.pendingPings.get(seq);
    if (sentAt === undefined) return;
    this.pendingPings.delete(seq);
    this.currentLatencySamples.push({ seq, rttMs: Date.now() - sentAt });
  }

  getBank(): StageBankEntry[] {
    return [...this.bank.values()];
  }

  /** Stops all timers/loops and returns the frozen bank snapshot. Safe to
   * call from any state, including before any stage began, and more than
   * once — every effect below is itself idempotent. */
  freeze(): StageBankEntry[] {
    this.stop();
    return this.getBank();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopPingLoop();
    this.clearStageTimeout();
    this.stage?.sender?.stop();
    this.stage?.receiver?.stop();
  }

  // --- transport barrier: stage-prepare / stage-armed / stage-start ------

  private beginStageAsCoordinator(stageId: StageId): void {
    this.initStage(stageId);
    this.sendRaw(JSON.stringify({ runId: this.runId, type: "stage-prepare", stageId, payload: {} }));
    this.armSelf(stageId);
  }

  private onStagePrepare(stageId: StageId): void {
    if (this.selfSlot === 0) return; // the coordinator originates this; never reacts to it
    this.initStage(stageId);
    this.armSelf(stageId);
  }

  private armSelf(stageId: StageId): void {
    if (!this.stage || this.stage.stageId !== stageId || this.stage.localArmedSent) return;
    this.stage.localArmedSent = true;
    this.sendRaw(JSON.stringify({ runId: this.runId, type: "stage-armed", stageId, payload: {} }));
    if (this.selfSlot === 0) this.maybeSendStart();
  }

  private onStageArmed(stageId: StageId): void {
    if (!this.stage || this.stage.stageId !== stageId) return;
    this.stage.peerArmed = true;
    if (this.selfSlot === 0) this.maybeSendStart();
  }

  private maybeSendStart(): void {
    const s = this.stage;
    if (!s || s.started || !s.localArmedSent || !s.peerArmed) return;
    this.sendRaw(JSON.stringify({ runId: this.runId, type: "stage-start", stageId: s.stageId, payload: {} }));
    this.beginTransfer(s.stageId);
  }

  private onStageStart(stageId: StageId): void {
    if (this.selfSlot === 0) return; // the coordinator already began via maybeSendStart
    this.beginTransfer(stageId);
  }

  private beginTransfer(stageId: StageId): void {
    const s = this.stage;
    if (!s || s.stageId !== stageId || s.started) return;
    s.started = true;
    this.currentLatencySamples = []; // this stage's own window starts now
    s.sender?.start();
    this.callbacks.onStageStarted?.(stageId);
  }

  // --- transport completion: stage-complete ------------------------------

  private onLocalSendComplete(stageId: StageId, _sentMeasuredChunks: number): void {
    const s = this.stage;
    if (!s || s.stageId !== stageId) return;
    s.localSendDone = true;
    this.maybeSendLocalStageComplete();
  }

  private onLocalReceiveClosed(stageId: StageId): void {
    const s = this.stage;
    if (!s || s.stageId !== stageId) return;
    s.localReceiveWindowClosed = true;
    this.maybeSendLocalStageComplete();
    this.attemptSealAndSendResult(stageId);
  }

  private maybeSendLocalStageComplete(): void {
    const s = this.stage;
    if (!s || s.localStageCompleteSent || !s.localSendDone || !s.localReceiveWindowClosed) return;
    s.localStageCompleteSent = true;
    const payload: { sentMeasuredChunks?: number } = s.sender
      ? { sentMeasuredChunks: s.sender.sentMeasuredChunks }
      : {};
    this.sendRaw(
      JSON.stringify({ runId: this.runId, type: "stage-complete", stageId: s.stageId, payload }),
    );
    if (this.selfSlot === 0) this.maybeAdvanceStage();
  }

  private onStageComplete(stageId: StageId, sentMeasuredChunks: number | undefined): void {
    const s = this.stage;
    if (!s || s.stageId !== stageId) return;
    s.remoteStageCompleteReceived = true;
    if (sentMeasuredChunks !== undefined) {
      s.remoteSentMeasuredChunks = sentMeasuredChunks;
      this.attemptSealAndSendResult(stageId);
    }
    if (this.selfSlot === 0) this.maybeAdvanceStage();
  }

  // --- bank barrier: stage-result / stage-result-ack ---------------------

  private attemptSealAndSendResult(stageId: StageId): void {
    const s = this.stage;
    if (
      !s ||
      s.stageId !== stageId ||
      !s.receiver ||
      s.localResultSent ||
      !s.localReceiveWindowClosed ||
      s.remoteSentMeasuredChunks === undefined
    ) {
      return;
    }
    const sealed = s.receiver.finalize(s.remoteSentMeasuredChunks);
    if (!sealed) return; // no usable total -> no edge; the stage timeout covers this
    const latency = this.currentLatencyAggregate();
    if (!latency) {
      // A stage fast enough to finish transferring before the ping cadence
      // has landed 3 round trips yet (S6's minimum) isn't a failure — the
      // link is just quick. Wait for more samples rather than declaring
      // this edge unsendable outright; the stage timeout is still the
      // backstop if samples genuinely never come (e.g. the control channel
      // itself is in trouble).
      setTimeout(() => this.attemptSealAndSendResult(stageId), PING_CADENCE_MS);
      return;
    }

    s.localResultSent = true;
    const measurement: Measurement = { ...sealed, latency: latency.rttMs, jitter: latency.jitterMs };
    const entry: StageBankEntry = { stageId, receiverSlot: this.selfSlot, measurement };
    const key = edgeKey(stageId, this.selfSlot);
    s.awaitingAck.add(key);
    this.bankLocally(entry);
    this.sendRaw(
      JSON.stringify({
        runId: this.runId,
        type: "stage-result",
        stageId,
        receiverSlot: this.selfSlot,
        payload: { measurement },
      }),
    );
  }

  private onStageResult(stageId: StageId, receiverSlot: Slot, measurement: Measurement): void {
    const s = this.stage;
    if (!s || s.stageId !== stageId) return;
    if (receiverSlot !== otherSlot(this.selfSlot)) return; // a forged direction is never banked
    this.bankLocally({ stageId, receiverSlot, measurement });
    this.sendRaw(
      JSON.stringify({ runId: this.runId, type: "stage-result-ack", stageId, receiverSlot, payload: {} }),
    );
  }

  private onStageResultAck(stageId: StageId, receiverSlot: Slot): void {
    const s = this.stage;
    if (!s || s.stageId !== stageId || receiverSlot !== this.selfSlot) return;
    s.awaitingAck.delete(edgeKey(stageId, receiverSlot));
    if (this.selfSlot === 0) this.maybeAdvanceStage();
  }

  private bankLocally(entry: StageBankEntry): void {
    const key = edgeKey(entry.stageId, entry.receiverSlot);
    if (this.bank.has(key)) return; // idempotent — a duplicate never re-adds
    this.bank.set(key, entry);
    this.callbacks.onEdgeBanked?.(entry);
    if (this.selfSlot === 0) this.maybeAdvanceStage();
    this.checkStagesDone();
  }

  private checkStagesDone(): void {
    if (this.stagesDoneFired) return;
    if (!allEdgeKeys().every((k) => this.bank.has(k))) return;
    this.stagesDoneFired = true;
    this.clearStageTimeout();
    this.callbacks.onStagesDone?.();
  }

  private maybeAdvanceStage(): void {
    const s = this.stage;
    if (!s) return;
    if (!(s.localStageCompleteSent && s.remoteStageCompleteReceived)) return;
    if (!s.neededKeys.every((k) => this.bank.has(k))) return;
    if (s.awaitingAck.size > 0) return;
    this.clearStageTimeout();
    const idx = STAGE_ORDER.indexOf(s.stageId);
    const next = STAGE_ORDER[idx + 1];
    if (next !== undefined) this.beginStageAsCoordinator(next);
  }

  // --- live progress -------------------------------------------------------

  private onLocalProgress(stageId: StageId, snapshot: {
    elapsedMs: number;
    bytes: number;
    chunksSeen: number;
    highestSeqPlusOne: number;
  }): void {
    const s = this.stage;
    if (!s || s.stageId !== stageId) return;
    const progressSeq = s.progressSeq++;
    this.sendRaw(
      JSON.stringify({
        runId: this.runId,
        type: "measurement-progress",
        stageId,
        receiverSlot: this.selfSlot,
        progressSeq,
        payload: snapshot,
      }),
    );
    this.callbacks.onProgress?.({ stageId, receiverSlot: this.selfSlot, ...snapshot });
  }

  private onRemoteProgress(msg: MeasurementProgressMessage): void {
    if (!this.stage || this.stage.stageId !== msg.stageId) return;
    const last = this.lastRemoteProgressSeq.get(msg.receiverSlot) ?? -1;
    if (msg.progressSeq <= last) return;
    this.lastRemoteProgressSeq.set(msg.receiverSlot, msg.progressSeq);
    this.callbacks.onProgress?.({ stageId: msg.stageId, receiverSlot: msg.receiverSlot, ...msg.payload });
  }

  // --- setup / continuous ping loop --------------------------------------

  private initStage(stageId: StageId): void {
    this.clearStageTimeout();
    const senderRole = isSender(stageId, this.selfSlot);
    const receiverRole = isReceiver(stageId, this.selfSlot);

    const sender = senderRole
      ? new BulkSender({
          channels: this.bulkChannels,
          runId: this.runId,
          stageId,
          chunkBytes: this.testConfig.chunkBytes,
          maxDurationMs: this.testConfig.maxDurationMs,
          maxBytes: this.testConfig.maxBytes,
          onComplete: (n) => this.onLocalSendComplete(stageId, n),
        })
      : null;

    const receiver = receiverRole
      ? new BulkReceiver({
          runId: this.runId,
          stageId,
          maxDurationMs: this.testConfig.maxDurationMs,
          onProgress: (snap) => this.onLocalProgress(stageId, snap),
          onWindowClosed: () => this.onLocalReceiveClosed(stageId),
        })
      : null;
    receiver?.arm();

    const neededKeys =
      stageId === DUPLEX
        ? [edgeKey(DUPLEX, 0), edgeKey(DUPLEX, 1)]
        : [edgeKey(stageId, directionalReceiverSlot(stageId))];

    this.stage = {
      stageId,
      sender,
      receiver,
      neededKeys,
      localArmedSent: false,
      peerArmed: false,
      started: false,
      localSendDone: !senderRole,
      localReceiveWindowClosed: !receiverRole,
      localStageCompleteSent: false,
      remoteStageCompleteReceived: false,
      remoteSentMeasuredChunks: undefined,
      localResultSent: false,
      awaitingAck: new Set(),
      progressSeq: 0,
      timeoutTimer: setTimeout(() => this.onStageTimeout(stageId), stageTimeoutMs(this.testConfig)),
    };
  }

  private onStageTimeout(stageId: StageId): void {
    if (!this.stage || this.stage.stageId !== stageId) return;
    this.callbacks.onTimeout?.();
  }

  private clearStageTimeout(): void {
    if (this.stage?.timeoutTimer) {
      clearTimeout(this.stage.timeoutTimer);
      this.stage.timeoutTimer = null;
    }
  }

  private startPingLoop(): void {
    this.pingTimer = setInterval(() => this.sendPing(), PING_CADENCE_MS);
    this.sendPing();
  }

  private stopPingLoop(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.pendingPings.clear();
  }

  private sendPing(): void {
    const seq = this.nextPingSeq++;
    this.pendingPings.set(seq, Date.now());
    this.sendRaw(JSON.stringify({ runId: this.runId, type: "ping", seq, payload: {} }));
  }

  // Non-destructive: the window boundary is `beginTransfer`'s reset at the
  // *next* stage's start, not this read. A very fast stage can otherwise
  // finish before the ping cadence lands 3 samples, and `attemptSealAnd-
  // SendResult` retries this same read rather than starting a fresh window
  // each time — retrying would just keep discarding partial progress.
  private currentLatencyAggregate(): Aggregate | null {
    return aggregateSamples(this.currentLatencySamples);
  }
}

// --- Terminal finalization (4.4) -------------------------------------------

export type FinalizeTrigger =
  | { kind: "clean" }
  | { kind: "local-abort"; status: "CANCELED" | "FAILED"; reason: string }
  | { kind: "remote-abort"; status: "CANCELED" | "FAILED"; reason: string }
  | { kind: "remote-run-ended"; reason: string };

export interface TerminalPeerInfo {
  slot: Slot;
  peerId: string;
  profile: ReceivedPeerProfile | null;
}

export interface TerminalOutcome {
  status: ResultStatus;
  record: P2PSpeedtestResult | null;
  validation: ValidationResult | null;
}

export interface TerminalControllerOptions {
  runId: string;
  room: string;
  timestamp: string;
  selfSlot: Slot;
  selfPeerId: string;
  send: (raw: string) => void;
  /** Freezes the stage orchestrator and returns its bank snapshot — called
   * exactly once, as the very first ordered action (4.4 step 1). */
  freezeStages: () => StageBankEntry[];
  getConnectionType: () => ConnectionType;
  getPeers: () => [TerminalPeerInfo, TerminalPeerInfo];
}

const PEER_SHARE_TIMEOUT_MS = 5_000;
const STATUS_RANK: Record<ResultStatus, number> = { SUCCEED: 0, CANCELED: 1, FAILED: 2 };

function moreSevere(a: ResultStatus, b: ResultStatus): ResultStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

/** The one run-scoped, idempotent finalization controller (4.4). Every
 * trigger — clean completion, local cancel/failure, a remote abort, or a
 * remote `run-ended` — joins the same promise; only the first call starts
 * it, and every later call just contributes its status/reason to the
 * reduction below before returning the same result. */
export class TerminalController {
  private readonly opts: TerminalControllerOptions;
  private reducedStatus: ResultStatus = "SUCCEED";
  private reducedReason: string | null = null;
  private runPromise: Promise<TerminalOutcome> | null = null;
  private peerShare: ResultSharePayload | null = null;
  private resolvePeerShareWait: (() => void) | null = null;

  constructor(opts: TerminalControllerOptions) {
    this.opts = opts;
  }

  /** Joins (and if needed starts) the single finalization run. Safe to call
   * repeatedly and concurrently — every caller gets the same outcome. */
  trigger(t: FinalizeTrigger): Promise<TerminalOutcome> {
    const status: ResultStatus = t.kind === "clean" ? "SUCCEED" : t.kind === "remote-run-ended" ? "FAILED" : t.status;
    const reason = t.kind === "clean" ? null : t.reason;
    this.reducedStatus = moreSevere(this.reducedStatus, status);
    if (this.reducedReason === null && reason !== null) this.reducedReason = reason;

    if (!this.runPromise) this.runPromise = this.run();
    return this.runPromise;
  }

  /** A `result-share` from the peer, decoded elsewhere. Only the first is
   * kept — idempotent by construction, matching the "at most one share"
   * rule this exchange runs under. */
  handleResultShare(payload: ResultSharePayload): void {
    if (this.peerShare) return;
    this.peerShare = payload;
    this.resolvePeerShareWait?.();
  }

  private async run(): Promise<TerminalOutcome> {
    // 1. Freeze first — before anything else touches shared state.
    const bank = this.opts.freezeStages();

    // 2. Propagate a local cancel/failure, if this is one.
    if (this.reducedStatus !== "SUCCEED") {
      this.sendRaw({
        runId: this.opts.runId,
        type: "test-abort",
        payload: { status: this.reducedStatus, reason: this.reducedReason ?? "unknown" },
      });
    }

    // 3. Send exactly one local share, then wait briefly for the peer's.
    const localVia = this.opts.getConnectionType();
    const localShare = this.buildLocalShare(bank, localVia);
    this.sendRaw({ runId: this.opts.runId, type: "result-share", payload: localShare });
    await this.waitForPeerShare();

    const finalStatus = moreSevere(localShare.status, this.peerShare?.status ?? "FAILED");
    const via = this.combineVia(localVia, this.peerShare?.via);
    const mergedBank = this.mergeShareIntoBank(bank, this.peerShare);

    // 4. Assemble, validate, hash, and make exactly one save attempt.
    const [a, b] = this.opts.getPeers();
    const data = assembleResult({
      room: this.opts.room,
      timestamp: this.opts.timestamp,
      status: finalStatus,
      via,
      peers: [a, b],
      bank: mergedBank,
    });
    const validation = validateData(data, this.opts.room);
    if (!validation.valid) {
      console.warn("TerminalController: assembled data failed validation", validation.errors);
      return { status: finalStatus, record: null, validation };
    }
    const hash = await computeResultHash(data);
    const record: P2PSpeedtestResult = {
      apiVersion: "sws.aries0d0f.me/v1",
      kind: "P2PSpeedtestResult",
      metadata: buildMetadata(this.opts.room, this.opts.selfPeerId, hash),
      data,
    };
    const saveOutcome = await saveResult(record);
    if (saveOutcome.status === "error") {
      console.warn("TerminalController: saveResult failed", saveOutcome.reason);
    }
    return { status: finalStatus, record, validation };
  }

  private buildLocalShare(bank: StageBankEntry[], via: ConnectionType): ResultSharePayload {
    const selfSlot = this.opts.selfSlot;
    const directional = bank.find((e) => e.stageId !== DUPLEX && e.receiverSlot === selfSlot)?.measurement;
    const duplex = bank.find((e) => e.stageId === DUPLEX && e.receiverSlot === selfSlot)?.measurement;

    if (this.reducedStatus === "SUCCEED" && directional && duplex) {
      return { status: "SUCCEED", directional, duplex, via };
    }
    return {
      status: this.reducedStatus === "SUCCEED" ? "FAILED" : this.reducedStatus,
      reason: this.reducedReason ?? "incomplete-measurement",
      ...(directional ? { directional } : {}),
      ...(duplex ? { duplex } : {}),
      via,
    };
  }

  private combineVia(local: ConnectionType, peer: ConnectionType | undefined): ConnectionType {
    if (local === "RELAY" || peer === "RELAY") return "RELAY";
    if (local === "DIRECT" || peer === "DIRECT") return "DIRECT";
    return "UNKNOWN";
  }

  /** Terminal replay merged idempotently with the stage bank (4.2's
   * "Notes on the shape"): a value that conflicts with an already-banked
   * edge is a protocol failure and is dropped rather than overwriting it —
   * the already-acknowledged bank entry always wins. */
  private mergeShareIntoBank(bank: StageBankEntry[], peer: ResultSharePayload | null): StageBankEntry[] {
    const map = new Map(bank.map((e) => [edgeKey(e.stageId, e.receiverSlot), e]));
    if (peer) {
      const peerSlot = otherSlot(this.opts.selfSlot);
      if (peer.directional) {
        const stageId = peerSlot === 1 ? DOWNLOAD : UPLOAD;
        const key = edgeKey(stageId, peerSlot);
        if (!map.has(key)) map.set(key, { stageId, receiverSlot: peerSlot, measurement: peer.directional });
      }
      if (peer.duplex) {
        const key = edgeKey(DUPLEX, peerSlot);
        if (!map.has(key)) map.set(key, { stageId: DUPLEX, receiverSlot: peerSlot, measurement: peer.duplex });
      }
    }
    return [...map.values()];
  }

  private async waitForPeerShare(): Promise<void> {
    if (this.peerShare) return;
    await new Promise<void>((resolve) => {
      this.resolvePeerShareWait = resolve;
      setTimeout(resolve, PEER_SHARE_TIMEOUT_MS);
    });
  }

  private sendRaw(msg: unknown): void {
    try {
      this.opts.send(JSON.stringify(msg));
    } catch {
      // Control channel already gone — this run has nothing left to send to.
    }
  }
}
