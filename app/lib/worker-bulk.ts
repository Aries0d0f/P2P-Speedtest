/**
 * Main-thread side of the worker-transport revision (see
 * 04-throughput-measurement.md's revision log). `BulkWorkerHandle` wraps
 * one dedicated Worker owning one transferred bulk `RTCDataChannel`.
 * `WorkerBulkStage` fans one stage's sender/receiver setup out across every
 * handle and aggregates their independent, asynchronous results back into
 * the same shape `throughput.ts`'s single-threaded `BulkSender`/
 * `BulkReceiver` already gave `control-channel.ts` — so `StageOrchestrator`
 * only had to swap which class it constructs, not how it uses it.
 *
 * Both roles for one stage (sender and/or receiver — duplex needs both)
 * are set up together in one `prepare-stage` message per worker, because
 * the worker resets its per-stage state on that message; sending two
 * separate messages (one sender-only, one receiver-only) would have the
 * second overwrite the first.
 */

import type { StageId } from "./stage";
import type {
  MainToWorkerMessage,
  ReceiverCloseReasonMessage,
  ReceiverSnapshotMessage,
  SealedMeasurementMessage,
  SenderStageConfig,
  WorkerToMainMessage,
} from "./worker-bulk-protocol";

// --- One worker, one channel --------------------------------------------

/** The initialized main-thread endpoint WorkerBulkStage needs. Keeping the
 * orchestration boundary structural lets tests run the exact worker core
 * in-process without pretending the runtime can transfer RTCDataChannels. */
export interface BulkWorkerPort {
  readonly workerId: number;
  onMessage(listener: (msg: WorkerToMainMessage) => void): () => void;
  send(msg: MainToWorkerMessage): void;
  terminate(): void;
}

export class BulkWorkerHandle implements BulkWorkerPort {
  readonly workerId: number;
  private readonly worker: Worker;
  private readonly listeners = new Set<(msg: WorkerToMainMessage) => void>();
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;

  constructor(workerId: number) {
    this.workerId = workerId;
    this.worker = new Worker(new URL("./bulk-worker.ts", import.meta.url), { type: "module" });
    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
    this.worker.onmessage = (event: MessageEvent<WorkerToMainMessage>) => {
      const msg = event.data;
      if (msg.type === "ready") this.resolveReady();
      for (const listener of this.listeners) listener(msg);
    };
  }

  /** Returns an unsubscribe function — callers must detach when a stage
   * wrapper is done with this handle, or listeners accumulate for the
   * handle's whole (multi-stage) lifetime. */
  onMessage(listener: (msg: WorkerToMainMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Transfers `channel` to this worker — this must be called synchronously
   * from the channel's creation/datachannel-event task. The main thread
   * loses direct access from this call on; every further interaction
   * happens by message. Resolves once the worker observes the channel open. */
  init(runId: string, channel: RTCDataChannel): Promise<void> {
    this.worker.postMessage({ type: "init", runId, workerId: this.workerId, channel }, [
      channel as unknown as Transferable,
    ]);
    return this.readyPromise;
  }

  send(msg: MainToWorkerMessage): void {
    this.worker.postMessage(msg);
  }

  /** Tells the worker to close its channel and stops the Worker thread
   * itself. Terminal — never used again after this. */
  terminate(): void {
    try {
      this.worker.postMessage({ type: "close" } satisfies MainToWorkerMessage);
    } catch {
      // already gone
    }
    this.worker.terminate();
  }
}

// --- One stage, fanned out across every handle ---------------------------

export interface WorkerSenderConfig {
  chunkBytes: number;
  maxDurationMs: number;
  maxBytes: number;
  rampUpMs: number;
}

export interface WorkerReceiverConfig {
  maxDurationMs: number;
  rampUpMs: number;
}

export interface WorkerBulkStageOptions {
  workers: BulkWorkerPort[];
  runId: string;
  stageId: StageId;
  /** `null` when this peer holds no sender role for this stage. Applies to
   * every worker uniformly — striped across all of them — matching how a
   * stage's sender/receiver role is a whole-peer decision (S5), not a
   * per-channel one. */
  senderConfig: WorkerSenderConfig | null;
  receiverConfig: WorkerReceiverConfig | null;
  onSenderComplete?: (totalSentCount: number) => void;
  onProgress?: (snapshot: ReceiverSnapshotMessage) => void;
  onWindowClosed?: (reason: ReceiverCloseReasonMessage) => void;
}

const PROGRESS_AGGREGATE_THROTTLE_MS = 50;

/** The worker-backed replacement for one stage's `BulkSender`/
 * `BulkReceiver` pair, aggregating `workers.length` independent Worker
 * threads into the single sender/receiver view `StageOrchestrator`
 * expects. Every per-worker measured-sequence stripe is disjoint by
 * construction (4.1's striping revision), so summing `chunksSeen`/`bytes`
 * across workers is always exact; only `durationMs` is an approximation
 * (the slowest worker's own window, rather than a precisely reconciled
 * cross-thread span) and `highestSeqPlusOne` for the *provisional* live
 * loss estimate is a max, not a sum — both documented where computed. */
export class WorkerBulkStage {
  private readonly opts: WorkerBulkStageOptions;
  private readonly senderWorkerIds: ReadonlySet<number>;
  private readonly receiverWorkerIds: ReadonlySet<number>;
  private readonly unsubscribes: Array<() => void> = [];

  private readonly senderDoneCounts = new Map<number, number>();
  private senderCompleteFired = false;

  private readonly receiverClosedIds = new Set<number>();
  private lastCloseReason: ReceiverCloseReasonMessage | null = null;
  private windowClosedFired = false;

  private readonly latestSnapshots = new Map<number, ReceiverSnapshotMessage>();
  private lastProgressEmitAt = -Infinity;

  private readonly sealedResolvers = new Map<number, (m: SealedMeasurementMessage | null) => void>();

  constructor(opts: WorkerBulkStageOptions) {
    this.opts = opts;
    this.senderWorkerIds = new Set(opts.senderConfig ? opts.workers.map((w) => w.workerId) : []);
    this.receiverWorkerIds = new Set(opts.receiverConfig ? opts.workers.map((w) => w.workerId) : []);

    for (const worker of opts.workers) {
      this.unsubscribes.push(worker.onMessage((msg) => this.handleMessage(worker.workerId, msg)));
    }

    const senderStride = this.senderWorkerIds.size;
    opts.workers.forEach((worker, i) => {
      const sender: SenderStageConfig | null =
        opts.senderConfig
          ? {
              chunkBytes: opts.senderConfig.chunkBytes,
              maxDurationMs: opts.senderConfig.maxDurationMs,
              // Divided across every sending worker so the aggregate across
              // all of them still respects the stage's total byte budget.
              maxBytes: Math.max(1, Math.ceil(opts.senderConfig.maxBytes / senderStride)),
              rampUpMs: opts.senderConfig.rampUpMs,
              seqStart: i,
              seqStride: senderStride,
            }
          : null;
      const receiver = opts.receiverConfig
        ? { maxDurationMs: opts.receiverConfig.maxDurationMs, rampUpMs: opts.receiverConfig.rampUpMs }
        : null;
      worker.send({ type: "prepare-stage", stageId: opts.stageId, sender, receiver });
    });
  }

  /** Only meaningful once every sender worker has reported "sender-done". */
  get sentMeasuredChunks(): number {
    let total = 0;
    for (const n of this.senderDoneCounts.values()) total += n;
    return total;
  }

  startSending(): void {
    if (!this.opts.senderConfig) return;
    for (const worker of this.opts.workers) {
      worker.send({ type: "start-sending", stageId: this.opts.stageId });
    }
  }

  /** Seals every receiver worker's own window with the same authoritative
   * total, then merges: `bytes`/`chunksSeen` sum exactly (disjoint
   * stripes); `chunksExpected` is the total itself, never summed;
   * `durationMs` takes the slowest worker's own window as an approximation
   * of the aggregate span. `null` if any one worker couldn't seal. */
  async finalizeReceiver(sentMeasuredChunksTotal: number): Promise<SealedMeasurementMessage | null> {
    if (this.receiverWorkerIds.size === 0) return null;
    const results = await Promise.all(
      [...this.receiverWorkerIds].map(
        (workerId) =>
          new Promise<SealedMeasurementMessage | null>((resolve) => {
            this.sealedResolvers.set(workerId, resolve);
            const worker = this.opts.workers.find((w) => w.workerId === workerId);
            worker?.send({
              type: "finalize-receiver",
              stageId: this.opts.stageId,
              sentMeasuredChunksTotal,
            });
          }),
      ),
    );
    if (results.some((m) => m === null)) return null;
    const sealed = results as SealedMeasurementMessage[];
    return {
      bytes: sealed.reduce((sum, m) => sum + m.bytes, 0),
      durationMs: Math.max(...sealed.map((m) => m.durationMs)),
      chunksSeen: sealed.reduce((sum, m) => sum + m.chunksSeen, 0),
      chunksExpected: sentMeasuredChunksTotal,
    };
  }

  /** Detaches this stage's listeners from every worker handle — the
   * handles themselves stay alive for the next stage. Idempotent. */
  dispose(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
  }

  private handleMessage(workerId: number, msg: WorkerToMainMessage): void {
    switch (msg.type) {
      case "sender-done": {
        if (msg.stageId !== this.opts.stageId) return;
        this.senderDoneCounts.set(workerId, msg.localSentCount);
        if (!this.senderCompleteFired && this.senderDoneCounts.size === this.senderWorkerIds.size) {
          this.senderCompleteFired = true;
          this.opts.onSenderComplete?.(this.sentMeasuredChunks);
        }
        return;
      }
      case "receiver-progress": {
        if (msg.stageId !== this.opts.stageId) return;
        this.latestSnapshots.set(workerId, msg.snapshot);
        this.maybeEmitProgress();
        return;
      }
      case "receiver-window-closed": {
        if (msg.stageId !== this.opts.stageId) return;
        this.receiverClosedIds.add(workerId);
        this.lastCloseReason = msg.reason;
        if (!this.windowClosedFired && this.receiverClosedIds.size === this.receiverWorkerIds.size) {
          this.windowClosedFired = true;
          this.opts.onWindowClosed?.(this.lastCloseReason);
        }
        return;
      }
      case "receiver-sealed": {
        const resolve = this.sealedResolvers.get(workerId);
        if (!resolve) return;
        this.sealedResolvers.delete(workerId);
        resolve(msg.measurement);
        return;
      }
      case "worker-error": {
        console.error(`bulk-worker ${workerId}: ${msg.message}`);
        return;
      }
      case "ready":
        return;
    }
  }

  private maybeEmitProgress(): void {
    if (!this.opts.onProgress) return;
    const now = Date.now();
    if (now - this.lastProgressEmitAt < PROGRESS_AGGREGATE_THROTTLE_MS) return;
    this.lastProgressEmitAt = now;

    let bytes = 0;
    let chunksSeen = 0;
    let highestSeqPlusOne = 0;
    let elapsedMs = 0;
    for (const snapshot of this.latestSnapshots.values()) {
      bytes += snapshot.bytes;
      chunksSeen += snapshot.chunksSeen;
      // A max, not a sum: each worker's own highest seq lives on its own
      // stripe, so this is an approximation of the aggregate's progress
      // through the stream — good enough for a *provisional* live loss
      // estimate, never used for the sealed, authoritative value.
      highestSeqPlusOne = Math.max(highestSeqPlusOne, snapshot.highestSeqPlusOne);
      elapsedMs = Math.max(elapsedMs, snapshot.elapsedMs);
    }
    this.opts.onProgress({ elapsedMs, bytes, chunksSeen, highestSeqPlusOne });
  }
}
