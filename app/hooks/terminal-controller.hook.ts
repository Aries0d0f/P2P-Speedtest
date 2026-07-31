import { useCallback, useEffect, useRef } from "react";

import { TerminalController } from "~/lib/terminal-controller";
import type { ConnectionType } from "~/model/connection.model";
import type { StageBankEntry } from "~/model/measurement.model";
import type { PeerWithProfile } from "~/model/peer.model";
import type { ResultShare } from "~/model/result.model";
import type {
  FinalizeTrigger,
  RoomRunContext,
  TerminalOutcome,
  TerminalReason,
} from "~/model/room.model";
import { useLatest } from "./latest.hook";

// Longer than the DO's ~5-second one-ack `run-ended` deadline (4.4 step 6):
// how long this peer keeps transport open after its own local finalization
// completes, waiting for `run-ended`, before tearing down anyway.
const LIFECYCLE_GRACE_MS = 8_000;

export interface TerminalControllerOptions {
  sendControlRaw: (raw: string) => void;
  sendRunFinished: (runId: string) => void;
  closeSocket: (code: number, reason: string) => void;
  teardownAll: () => void;
  freezeStages: () => StageBankEntry[];
  measurementStarted: () => boolean;
  getConnectionType: () => ConnectionType;
  getPeers: () => [PeerWithProfile, PeerWithProfile] | null;
  onPhase: (phase: "finalizing" | "result") => void;
  onTerminal: (reason: TerminalReason) => void;
  onOutcome: (outcome: TerminalOutcome) => void;
  /** Cleared whenever the pre-measurement path enters terminal. */
  clearProfileTimeout: () => void;
}

export interface TerminalControllerHandle {
  /** The one entry point into 4.4's terminal FSM. `TerminalController.trigger`
   * is itself idempotent, so calling this repeatedly is always safe; only the
   * first call owns the result, the `run-finished` send and the grace tail. */
  finalize: (trigger: FinalizeTrigger) => void;
  /** A local failure before any measurement: ends the DO's run too, because
   * merely closing the peer connection would leave the signaling socket
   * occupying its slot and strand the other browser in a live server run. */
  abortPreMeasurement: (reason: TerminalReason) => void;
  enterTerminal: (reason: TerminalReason) => void;
  handleResultShare: (payload: ResultShare) => void;
  /** Clears the grace timer and tears down immediately — `run-ended` after
   * measurement must not wait out the full grace window. */
  teardownNow: () => void;
}

export function useTerminalController(
  ctx: React.RefObject<RoomRunContext>,
  opts: TerminalControllerOptions,
): TerminalControllerHandle {
  const latest = useLatest(opts);
  const controllerRef = useRef<TerminalController | null>(null);
  const startedRef = useRef(false);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (graceTimerRef.current) clearTimeout(graceTimerRef.current);
    },
    [],
  );

  const enterTerminal = useCallback(
    (reason: TerminalReason) => {
      if (ctx.current.terminal) return;
      ctx.current.terminal = true;
      latest.current.clearProfileTimeout();
      latest.current.onTerminal(reason);
    },
    [ctx, latest],
  );

  const abortPreMeasurement = useCallback(
    (reason: TerminalReason) => {
      // Idempotent: every trigger can fire more than once (teardown itself
      // closes the channel, which fires `onChannelClose` again).
      if (ctx.current.terminal) return;
      console.warn(`abortPreMeasurement: ${reason}`);
      enterTerminal(reason);
      latest.current.closeSocket(4401, reason);
      latest.current.teardownAll();
    },
    [ctx, enterTerminal, latest],
  );

  const ensureController = useCallback((): TerminalController | null => {
    if (controllerRef.current) return controllerRef.current;
    const { self, runId, other, runTimestamp, slug } = ctx.current;
    if (!self || !runId || !other || !runTimestamp) return null;
    const peers = latest.current.getPeers();
    if (!peers) return null;

    controllerRef.current = new TerminalController({
      runId,
      room: slug,
      timestamp: runTimestamp,
      selfSlot: self.slot,
      selfPeerId: self.id,
      send: (raw) => latest.current.sendControlRaw(raw),
      freezeStages: () => latest.current.freezeStages(),
      getConnectionType: () => latest.current.getConnectionType(),
      getPeers: () => latest.current.getPeers()!,
    });
    return controllerRef.current;
  }, [ctx, latest]);

  const finalize = useCallback(
    (trigger: FinalizeTrigger) => {
      const controller = ensureController();
      if (!controller) {
        abortPreMeasurement("finalization-setup-failed");
        return;
      }
      if (startedRef.current) {
        void controller.trigger(trigger);
        return;
      }
      startedRef.current = true;
      latest.current.onPhase("finalizing");
      void controller.trigger(trigger).then((outcome) => {
        latest.current.onOutcome(outcome);
        latest.current.onPhase("result");
        latest.current.sendRunFinished(ctx.current.runId!);
        graceTimerRef.current = setTimeout(() => {
          latest.current.teardownAll();
        }, LIFECYCLE_GRACE_MS);
      });
    },
    [ctx, ensureController, abortPreMeasurement, latest],
  );

  const handleResultShare = useCallback(
    (payload: ResultShare) => ensureController()?.handleResultShare(payload),
    [ensureController],
  );

  const teardownNow = useCallback(() => {
    if (graceTimerRef.current) {
      clearTimeout(graceTimerRef.current);
      graceTimerRef.current = null;
    }
    latest.current.teardownAll();
  }, [latest]);

  return { finalize, abortPreMeasurement, enterTerminal, handleResultShare, teardownNow };
}
