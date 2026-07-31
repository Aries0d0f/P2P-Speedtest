import { useCallback, useEffect, useRef } from "react";

import { LatencySession, type LatencyHandoff } from "~/lib/latency";
import type { LatencyMessage } from "~/model/control-message.model";
import type { LatencyAggregate, LiveLatency } from "~/model/measurement.model";
import type { RoomRunContext } from "~/model/room.model";
import { useLatest } from "./latest.hook";

export interface LatencySessionOptions {
  onSamplingStarted: () => void;
  onLive: (live: LiveLatency) => void;
  /** The S5 gate's latency half: throughput may proceed regardless of whether
   * `baseline` is null. */
  onReady: (baseline: LatencyAggregate | null) => void;
  onReadyTimeout: () => void;
}

export interface LatencySessionHandle {
  /** Created synchronously on channel open, before any `await`, so
   * `sendChannelReady` can never be called on a missing instance. */
  create: (channel: RTCDataChannel) => void;
  sendChannelReady: () => void;
  handleMessage: (msg: LatencyMessage) => void;
  freezeForTerminal: (reason: "control-closed" | "run-ended") => void;
  /** True once the handoff has fired: from then on `ping`/`pong` belong to the
   * stage orchestrator's continuous loop, not this session. */
  handoffFired: () => boolean;
}

export function useLatencySession(
  ctx: React.RefObject<RoomRunContext>,
  opts: LatencySessionOptions,
): LatencySessionHandle {
  const latest = useLatest(opts);
  const sessionRef = useRef<LatencySession | null>(null);
  const handoffFiredRef = useRef(false);

  useEffect(() => () => sessionRef.current?.reset(), []);

  const create = useCallback(
    (channel: RTCDataChannel) => {
      if (sessionRef.current) return;
      const runId = ctx.current.runId;
      if (!runId) return;

      sessionRef.current = new LatencySession({
        runId,
        send: (raw) => channel.send(raw),
        callbacks: {
          onSamplingStarted: () => latest.current.onSamplingStarted(),
          onLive: (live) => latest.current.onLive(live),
          onHandoff: (handoff: LatencyHandoff) => {
            handoffFiredRef.current = true;
            if (handoff.kind === "ready") {
              latest.current.onReady(handoff.baseline);
              return;
            }
            // "control-closed" and "run-ended" are always paired with an
            // external event that already enters terminal itself — calling it
            // again here would win the race with a more specific reason. Only
            // the peer-ready timeout has no other trigger site.
            if (handoff.reason === "latency-ready-timeout") latest.current.onReadyTimeout();
          },
        },
      });
    },
    [ctx, latest],
  );

  const sendChannelReady = useCallback(() => sessionRef.current?.sendChannelReady(), []);
  const handleMessage = useCallback((msg: LatencyMessage) => {
    sessionRef.current?.handleMessage(msg);
  }, []);
  const freezeForTerminal = useCallback((reason: "control-closed" | "run-ended") => {
    sessionRef.current?.freezeForTerminal(reason);
  }, []);
  const handoffFired = useCallback(() => handoffFiredRef.current, []);

  return { create, sendChannelReady, handleMessage, freezeForTerminal, handoffFired };
}
