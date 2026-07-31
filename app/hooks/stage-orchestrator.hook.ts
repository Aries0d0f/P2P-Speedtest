import { useCallback, useEffect, useRef } from "react";

import { StageOrchestrator } from "~/lib/stage-orchestrator";
import type { BulkFrame } from "~/model/bulk-frame.model";
import type { StageMessage } from "~/model/control-message.model";
import type { StageBankEntry, StageProgress } from "~/model/measurement.model";
import type { RoomRunContext } from "~/model/room.model";
import type { StageId } from "~/model/stage.model";
import { useLatest } from "./latest.hook";

export interface StageOrchestratorOptions {
  sendControlRaw: (raw: string) => void;
  onStageStarted: (stage: StageId) => void;
  onProgress: (snapshot: StageProgress) => void;
  onStagesDone: () => void;
  onTimeout: () => void;
}

export interface StageOrchestratorHandle {
  /** The S5 gate, re-checked from every input that can complete it: all bulk
   * channels open, `test-config` in hand, latency ready, and this peer's own
   * slot and run id known. */
  maybeStart: () => void;
  /** Latency's half of the gate; set once the handoff reports "ready". */
  markLatencyReady: () => void;
  handleMessage: (msg: StageMessage) => void;
  handleBulkFrame: (frame: BulkFrame) => void;
  handlePing: (seq: number) => void;
  handlePong: (seq: number) => void;
  freeze: () => StageBankEntry[];
  /** Once this is true, measurement has begun (4.4): every later failure must
   * produce a record rather than the pre-measurement abort path. */
  started: () => boolean;
}

export function useStageOrchestrator(
  ctx: React.RefObject<RoomRunContext>,
  bulkChannels: React.RefObject<(RTCDataChannel | null)[]>,
  opts: StageOrchestratorOptions,
): StageOrchestratorHandle {
  const latest = useLatest(opts);
  const orchestratorRef = useRef<StageOrchestrator | null>(null);
  const latencyReadyRef = useRef(false);

  useEffect(() => () => orchestratorRef.current?.stop(), []);

  const maybeStart = useCallback(() => {
    if (orchestratorRef.current) return;
    const channels = bulkChannels.current;
    const { testConfig, self, runId } = ctx.current;
    if (channels.some((c) => c === null) || !testConfig || !latencyReadyRef.current || !self || !runId) {
      return;
    }

    const orchestrator = new StageOrchestrator({
      runId,
      selfSlot: self.slot,
      testConfig,
      send: (raw) => latest.current.sendControlRaw(raw),
      bulkChannels: channels as RTCDataChannel[],
      callbacks: {
        onStageStarted: (stage) => latest.current.onStageStarted(stage),
        onProgress: (snapshot) => latest.current.onProgress(snapshot),
        onStagesDone: () => latest.current.onStagesDone(),
        onTimeout: () => latest.current.onTimeout(),
      },
    });
    orchestratorRef.current = orchestrator;
    orchestrator.start();
  }, [ctx, bulkChannels, latest]);

  const markLatencyReady = useCallback(() => {
    latencyReadyRef.current = true;
  }, []);

  return {
    maybeStart,
    markLatencyReady,
    handleMessage: useCallback((msg: StageMessage) => {
      orchestratorRef.current?.handleMessage(msg);
    }, []),
    handleBulkFrame: useCallback((frame: BulkFrame) => {
      orchestratorRef.current?.handleBulkFrame(frame);
    }, []),
    handlePing: useCallback((seq: number) => orchestratorRef.current?.handlePing(seq), []),
    handlePong: useCallback((seq: number) => orchestratorRef.current?.handlePong(seq), []),
    freeze: useCallback(() => orchestratorRef.current?.freeze() ?? [], []),
    started: useCallback(() => orchestratorRef.current !== null, []),
  };
}
