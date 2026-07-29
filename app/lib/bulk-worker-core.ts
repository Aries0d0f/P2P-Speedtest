/**
 * The pure protocol logic one bulk worker runs (worker-transport revision
 * — see 04-throughput-measurement.md's revision log), factored out of
 * `bulk-worker.ts` so it has no dependency on `self`/`postMessage`/any
 * Worker-global: just `throughput.ts`'s `BulkSender`/`BulkReceiver` plus
 * the message protocol. `bulk-worker.ts` wraps this with the real Worker
 * globals; tests wrap the exact same class with an in-process fake instead
 * of a real `Worker` — both drive identical logic, so a test can't drift
 * from what actually runs in the worker.
 */

import { BulkReceiver, BulkSender, parseBulkFrame, type BulkChannel } from "./throughput";
import type { StageId } from "./stage";
import type { MainToWorkerMessage, WorkerToMainMessage } from "./worker-bulk-protocol";

/** The subset of `RTCDataChannel` this core needs beyond `BulkChannel`:
 * receiving messages and closing. A transferred `RTCDataChannel` satisfies
 * this directly. */
export interface BulkWorkerChannel extends BulkChannel {
  onmessage: ((event: MessageEvent) => void) | null;
  binaryType: string;
  close(): void;
}

export class BulkWorkerCore {
  private readonly runId: string;
  private readonly workerId: number;
  private readonly channel: BulkWorkerChannel;
  private readonly post: (msg: WorkerToMainMessage) => void;

  private currentStageId: StageId | null = null;
  private sender: BulkSender | null = null;
  private receiver: BulkReceiver | null = null;

  constructor(opts: {
    runId: string;
    workerId: number;
    channel: BulkWorkerChannel;
    post: (msg: WorkerToMainMessage) => void;
  }) {
    this.runId = opts.runId;
    this.workerId = opts.workerId;
    this.channel = opts.channel;
    this.post = opts.post;

    this.channel.binaryType = "arraybuffer";
    // Wired once, for the channel's whole (multi-stage) lifetime — `this.receiver`
    // is reassigned per stage by `prepare-stage`, so this closure always reaches
    // whichever one is current; a frame arriving with none current (between
    // stages, or before the first `prepare-stage`) is simply dropped.
    this.channel.onmessage = (event) => {
      const frame = parseBulkFrame(event.data as ArrayBuffer);
      if (frame) this.receiver?.handleFrame(frame);
    };
  }

  handle(msg: MainToWorkerMessage): void {
    switch (msg.type) {
      case "prepare-stage": {
        this.resetStage();
        this.currentStageId = msg.stageId;
        const stageId = msg.stageId;

        if (msg.sender) {
          const cfg = msg.sender;
          this.sender = new BulkSender({
            channels: [this.channel],
            runId: this.runId,
            stageId,
            chunkBytes: cfg.chunkBytes,
            maxDurationMs: cfg.maxDurationMs,
            maxBytes: cfg.maxBytes,
            rampUpMs: cfg.rampUpMs,
            seqStart: cfg.seqStart,
            seqStride: cfg.seqStride,
            onComplete: (localSentCount) =>
              this.post({ type: "sender-done", workerId: this.workerId, stageId, localSentCount }),
          });
        }

        if (msg.receiver) {
          const cfg = msg.receiver;
          this.receiver = new BulkReceiver({
            runId: this.runId,
            stageId,
            maxDurationMs: cfg.maxDurationMs,
            rampUpMs: cfg.rampUpMs,
            onProgress: (snapshot) =>
              this.post({ type: "receiver-progress", workerId: this.workerId, stageId, snapshot }),
            onWindowClosed: (reason) =>
              this.post({ type: "receiver-window-closed", workerId: this.workerId, stageId, reason }),
          });
          this.receiver.arm();
        }
        return;
      }

      case "start-sending": {
        if (this.currentStageId === msg.stageId) this.sender?.start();
        return;
      }

      case "finalize-receiver": {
        if (!this.receiver || this.currentStageId !== msg.stageId) {
          this.post({ type: "receiver-sealed", workerId: this.workerId, stageId: msg.stageId, measurement: null });
          return;
        }
        const measurement = this.receiver.finalize(msg.sentMeasuredChunksTotal);
        this.post({ type: "receiver-sealed", workerId: this.workerId, stageId: msg.stageId, measurement });
        return;
      }

      case "close": {
        this.resetStage();
        try {
          this.channel.close();
        } catch {
          // already closed
        }
        return;
      }

      case "init":
        return; // handled by the caller before this core exists
    }
  }

  private resetStage(): void {
    this.sender?.stop();
    this.receiver?.stop();
    this.sender = null;
    this.receiver = null;
    this.currentStageId = null;
  }
}
