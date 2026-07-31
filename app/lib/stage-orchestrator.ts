/**
 * The three-stage transport handshake (4.2).
 *
 * Slot 0 is always the coordinator — the only one that emits
 * `stage-prepare`/`stage-start`; both peers emit their own
 * `stage-armed`/`stage-complete` and, when they hold a receiver role, their own
 * `stage-result`. `ping`/`pong` keep running throughout every stage, and this
 * module segments that same RTT stream into one aggregate per stage window
 * using `latency.ts`'s exact `aggregateSamples` rule.
 */

import { aggregateSamples } from "./latency";
import { encodeControlMessage } from "./control-message";
import type { Slot, TestConfigPayload } from "~/model/signaling.model";
import type { BulkChannel, BulkFrame } from "~/model/bulk-frame.model";
import { BulkReceiver, BulkSender, RAMP_UP_MS } from "./throughput";
import type {
  LatencyAggregate,
  Measurement,
  MeasurementProgress,
  Sample,
  StageBankEntry,
  StageProgress,
} from "~/model/measurement.model";
import type { ControlMessageOf, StageMessage } from "~/model/control-message.model";
import {
  DOWNLOAD,
  DUPLEX,
  STAGE_ORDER,
  allEdgeKeys,
  edgeKey,
  isReceiver,
  isSender,
  otherSlot,
  type StageId,
} from "~/model/stage.model";

const PING_CADENCE_MS = 200;
// Generous margin over the sender's own ramp-up + measured budget for
// handshake round trips (prepare/armed/start plus the result/ack pair) —
// distinct from BulkReceiver's own, tighter hard deadline for the receive
// window alone.
const HANDSHAKE_BUFFER_MS = 6_000;

function stageTimeoutMs(testConfig: TestConfigPayload): number {
  return RAMP_UP_MS + testConfig.maxDurationMs + HANDSHAKE_BUFFER_MS;
}

export interface StageOrchestratorCallbacks {
  onStageStarted?: (stage: StageId) => void;
  onProgress?: (snapshot: StageProgress) => void;
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

  private onLocalProgress(stageId: StageId, snapshot: MeasurementProgress): void {
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

  private onRemoteProgress(msg: ControlMessageOf<"measurement-progress">): void {
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
  private currentLatencyAggregate(): LatencyAggregate | null {
    return aggregateSamples(this.currentLatencySamples);
  }
}
