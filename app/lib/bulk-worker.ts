/**
 * One dedicated Worker per bulk data channel (worker-transport revision —
 * see 04-throughput-measurement.md's revision log). Runs entirely off the
 * main thread: owns one transferred `RTCDataChannel` for the whole run and
 * drives `throughput.ts`'s `BulkSender`/`BulkReceiver` against it directly
 * — a transferred channel satisfies the `BulkChannel` interface exactly as
 * it does on the main thread, so neither class needed a single change to
 * run here. `worker-bulk.ts` (main thread) is this file's only correspondent;
 * see `worker-bulk-protocol.ts` for the message shapes both sides share.
 */

import { BulkReceiver, BulkSender, parseBulkFrame, type BulkChannel } from "./throughput";
import type { MainToWorkerMessage, WorkerToMainMessage } from "./worker-bulk-protocol";
import type { StageId } from "./stage";

let runId: string | null = null;
let workerId = -1;
let channel: RTCDataChannel | null = null;

let currentStageId: StageId | null = null;
let sender: BulkSender | null = null;
let receiver: BulkReceiver | null = null;

function post(msg: WorkerToMainMessage): void {
  self.postMessage(msg);
}

function resetStage(): void {
  sender?.stop();
  receiver?.stop();
  sender = null;
  receiver = null;
  currentStageId = null;
}

self.onmessage = (event: MessageEvent<MainToWorkerMessage>) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case "init": {
        runId = msg.runId;
        workerId = msg.workerId;
        channel = msg.channel;
        // The main thread transfers in the creation task, so this channel
        // usually still has readyState "connecting". This worker owns all
        // event handling from here onward.
        channel.binaryType = "arraybuffer";
        // Wired once, for the channel's whole (multi-stage) lifetime here
        // — `receiver` is reassigned per stage by `prepare-stage`, so this
        // closure always reaches whichever one is current; a frame
        // arriving with no current receiver (between stages, or before the
        // first `prepare-stage`) is simply dropped, same as the main-thread
        // orchestrator did before this revision.
        channel.onmessage = (event: MessageEvent) => {
          const frame = parseBulkFrame(event.data as ArrayBuffer);
          if (frame) receiver?.handleFrame(frame);
        };
        const postReady = () => post({ type: "ready", workerId });
        if (channel.readyState === "open") {
          postReady();
        } else {
          // Readiness continues to mean "the bulk channel is open", as it
          // did when initialization happened from the main thread's
          // onopen callback. Only ownership transfer moved earlier.
          channel.onopen = postReady;
        }
        return;
      }

      case "prepare-stage": {
        if (!runId || !channel) throw new Error("prepare-stage before init");
        resetStage();
        currentStageId = msg.stageId;
        const stageId = msg.stageId;
        const bulkChannel: BulkChannel = channel;

        if (msg.sender) {
          const cfg = msg.sender;
          sender = new BulkSender({
            channels: [bulkChannel],
            runId,
            stageId,
            chunkBytes: cfg.chunkBytes,
            maxDurationMs: cfg.maxDurationMs,
            maxBytes: cfg.maxBytes,
            rampUpMs: cfg.rampUpMs,
            seqStart: cfg.seqStart,
            seqStride: cfg.seqStride,
            onComplete: (localSentCount) => {
              post({ type: "sender-done", workerId, stageId, localSentCount });
            },
          });
        }

        if (msg.receiver) {
          const cfg = msg.receiver;
          receiver = new BulkReceiver({
            runId,
            stageId,
            maxDurationMs: cfg.maxDurationMs,
            rampUpMs: cfg.rampUpMs,
            onProgress: (snapshot) => post({ type: "receiver-progress", workerId, stageId, snapshot }),
            onWindowClosed: (reason) =>
              post({ type: "receiver-window-closed", workerId, stageId, reason }),
          });
          receiver.arm();
        }
        return;
      }

      case "start-sending": {
        if (currentStageId === msg.stageId) sender?.start();
        return;
      }

      case "finalize-receiver": {
        if (!receiver || currentStageId !== msg.stageId) {
          post({ type: "receiver-sealed", workerId, stageId: msg.stageId, measurement: null });
          return;
        }
        const measurement = receiver.finalize(msg.sentMeasuredChunksTotal);
        post({ type: "receiver-sealed", workerId, stageId: msg.stageId, measurement });
        return;
      }

      case "close": {
        resetStage();
        try {
          channel?.close();
        } catch {
          // already closed
        }
        return;
      }
    }
  } catch (err) {
    post({ type: "worker-error", workerId, message: err instanceof Error ? err.message : String(err) });
  }
};
