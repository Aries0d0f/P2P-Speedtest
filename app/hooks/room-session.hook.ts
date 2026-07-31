import { useCallback, useEffect } from "react";

import { decodeControlMessage } from "~/lib/control-message";
import { parseBulkFrame } from "~/lib/throughput";
import type { ChannelLabel } from "~/model/connection.model";
import type { ConfirmedProfile, PeerProfile, PeerWithProfile } from "~/model/peer.model";
import type { Envelope } from "~/model/signaling.model";
import type { RoomState, TerminalReason } from "~/model/room.model";

import { useLatencySession } from "./latency-session.hook";
import { usePeerConnections } from "./peer-connections.hook";
import { usePeerProfileExchange } from "./peer-profile-exchange.hook";
import { useRoomRunContext } from "./room-run-context.hook";
import { useSignalingSocket } from "./signaling-socket.hook";
import { useStageOrchestrator } from "./stage-orchestrator.hook";
import { useTerminalController } from "./terminal-controller.hook";

const UNKNOWN_PEER_ID = "00000000-0000-5000-8000-000000000000";

export interface RoomSessionHandle {
  state: RoomState;
  cancel: () => void;
  /** Display-only self marker, published by the geo prefetch before any
   * `peer-profile` message exists. Never overwrites a real one. */
  setProvisionalSelfProfile: (profile: PeerProfile) => void;
}

/**
 * The whole room run, composed.
 *
 * Hook order is the data flow — socket, then transport, then everything that
 * runs over it — but it is not a call-order constraint: every sub-hook reads
 * its options through a ref, so a callback registered early can still reach a
 * hook declared later, exactly as the original single effect's hoisted
 * function declarations did.
 */
export function useRoomSession(
  token: number | null,
  slug: string,
  profile: ConfirmedProfile | null,
  userAgent: string,
): RoomSessionHandle {
  const room = useRoomRunContext(token, slug, profile);
  const { ctx } = room;
  const enabled = token !== null && profile !== null;

  const socket = useSignalingSocket(ctx, enabled, {
    onEnvelope: (envelope) => onEnvelope(envelope),
    onExpired: () => {
      // Hard expiry always wins (S2) and can land after measurement has begun,
      // so it joins the terminal finalizer once a record is in play.
      if (stages.started()) {
        terminal.finalize({ kind: "local-abort", status: "FAILED", reason: "expired" });
      } else {
        terminal.enterTerminal("expired");
      }
    },
  });

  const connections = usePeerConnections(ctx, {
    send: socket.send,
    onPaired: () => room.setPhase("paired"),
    onConnectionType: room.setConnectionType,
    onFailure: (reason) => {
      if (stages.started()) {
        terminal.finalize({ kind: "local-abort", status: "FAILED", reason });
      } else {
        terminal.abortPreMeasurement(reason as TerminalReason);
      }
    },
    onControlOpen: (channel) => {
      // Created synchronously, before the profile exchange's first `await`, so
      // `sendChannelReady` can never be called on a missing instance.
      latency.create(channel);
      void profileExchange.begin(channel);
    },
    onBulkOpen: () => stages.maybeStart(),
    onChannelMessage: (label, event) => onChannelMessage(label, event),
    onChannelClose: (label) => onChannelClose(label),
  });

  const profileExchange = usePeerProfileExchange(ctx, {
    userAgent,
    getOwnAddress: connections.getOwnAddress,
    sendControlRaw: connections.sendControlRaw,
    onSelfProfile: room.setSelfProfile,
    onOtherProfile: room.setOtherProfile,
    onRunTimestamp: room.setRunTimestamp,
    onExchangeComplete: () => latency.sendChannelReady(),
    onTimeout: () => terminal.abortPreMeasurement("profile-timeout"),
  });

  const latency = useLatencySession(ctx, {
    onSamplingStarted: () => room.setPhase("testing"),
    onLive: room.setLiveLatency,
    onReady: (baseline) => {
      room.setLatencyBaseline(baseline);
      stages.markLatencyReady();
      stages.maybeStart();
    },
    onReadyTimeout: () => terminal.enterTerminal("latency-ready-timeout"),
  });

  const stages = useStageOrchestrator(ctx, connections.bulkChannels, {
    sendControlRaw: connections.sendControlRaw,
    onStageStarted: room.setStageId,
    onProgress: room.recordProgress,
    onStagesDone: () => terminal.finalize({ kind: "clean" }),
    onTimeout: () =>
      terminal.finalize({ kind: "local-abort", status: "FAILED", reason: "stage-timeout" }),
  });

  const terminal = useTerminalController(ctx, {
    sendControlRaw: connections.sendControlRaw,
    sendRunFinished: (runId) => socket.send({ type: "run-finished", runId, payload: {} }),
    closeSocket: socket.close,
    teardownAll: connections.teardownAll,
    freezeStages: stages.freeze,
    measurementStarted: stages.started,
    getConnectionType: () => ctx.current.connectionType,
    getPeers: (): [PeerWithProfile, PeerWithProfile] | null => {
      const { self, other, selfProfile, otherProfile } = ctx.current;
      if (!self || !other) return null;
      return [
        { slot: self.slot, id: self.id, profile: selfProfile },
        { slot: other.slot, id: other.id || UNKNOWN_PEER_ID, profile: otherProfile },
      ];
    },
    onPhase: room.setPhase,
    onTerminal: room.setTerminal,
    onOutcome: room.setOutcome,
    clearProfileTimeout: () => profileExchange.clearTimeout(),
  });

  const onChannelMessage = useCallback(
    (label: ChannelLabel, event: MessageEvent) => {
      if (label === "bulk") {
        const frame = parseBulkFrame(event.data as ArrayBuffer);
        if (frame) stages.handleBulkFrame(frame);
        return;
      }
      const runId = ctx.current.runId;
      if (label !== "control" || !runId || !ctx.current.other) return;

      const msg = decodeControlMessage(event.data, runId);
      if (!msg) return;

      switch (msg.type) {
        case "channel-ready":
        case "latency-ready":
          latency.handleMessage(msg);
          return;
        // Ping/pong keep running for the whole testing phase (4.2): once the
        // latency handoff fires, its own loop has stopped, so later ping/pong
        // belong to the stage orchestrator's continuous loop.
        case "ping":
          if (latency.handoffFired()) stages.handlePing(msg.seq);
          else latency.handleMessage(msg);
          return;
        case "pong":
          if (latency.handoffFired()) stages.handlePong(msg.seq);
          else latency.handleMessage(msg);
          return;
        case "test-abort":
          terminal.finalize({
            kind: "remote-abort",
            status: msg.payload.status,
            reason: msg.payload.reason,
          });
          return;
        case "result-share":
          terminal.handleResultShare(msg.payload);
          return;
        case "peer-profile":
          profileExchange.handleIncoming(msg.payload);
          return;
        default:
          stages.handleMessage(msg);
      }
    },
    [ctx, latency, stages, terminal, profileExchange],
  );

  const onChannelClose = useCallback(
    (label: ChannelLabel) => {
      if (label !== "control") return;
      // Post-start (3.2): freeze whatever samples already arrived before the
      // abort path tears anything down.
      if (ctx.current.phase === "testing") latency.freezeForTerminal("control-closed");
      if (stages.started()) {
        terminal.finalize({ kind: "local-abort", status: "FAILED", reason: "channel-closed" });
      } else {
        terminal.abortPreMeasurement("channel-closed");
      }
    },
    [ctx, latency, stages, terminal],
  );

  const onEnvelope = useCallback(
    (envelope: Envelope) => {
      switch (envelope.type) {
        case "peer-assigned":
          room.setSelf(
            { slot: envelope.payload.slot, id: envelope.payload.peerId },
            envelope.payload.expiresAt,
          );
          return;
        case "peer-joined":
          room.setOther({ slot: envelope.payload.slot, id: envelope.payload.peerId });
          return;
        case "run-started": {
          room.setRunId(envelope.runId);
          room.setPhase("pairing");
          const otherPeer = envelope.payload.peers.find((p) => p.slot !== ctx.current.self?.slot);
          if (otherPeer) room.setOther({ slot: otherPeer.slot, id: otherPeer.peerId });
          profileExchange.armTimeout();
          return;
        }
        case "test-config":
          // Snapshotted at room claim and replayed on every accept, so this
          // always arrives — no client-side fallback constant is substituted.
          room.setTestConfig(envelope.payload);
          stages.maybeStart();
          return;
        case "ice-servers":
          connections.createConnections(envelope.payload.iceServers);
          return;
        case "run-ended": {
          // Post-start (3.2): freeze whatever samples arrived before tearing
          // anything down, so a FAILED partial record has real data even
          // though no throughput edge exists yet.
          if (ctx.current.phase === "testing") latency.freezeForTerminal("run-ended");
          if (stages.started()) {
            // Joins the same terminal controller (4.4 step 6), and supersedes
            // the generic pre-measurement terminal screen.
            terminal.finalize({ kind: "remote-run-ended", reason: envelope.payload.reason });
            terminal.teardownNow();
          } else {
            connections.teardownAll();
            terminal.enterTerminal(envelope.payload.reason);
          }
          return;
        }
        case "ping":
          socket.send({ type: "pong", runId: envelope.runId, payload: {} });
          return;
        case "offer":
        case "answer":
        case "ice-candidate":
          connections.connectionFor(envelope.connIndex)?.handleSignalingMessage(envelope);
          return;
        default:
          return;
      }
    },
    [ctx, room, socket, connections, latency, stages, terminal, profileExchange],
  );

  // Transport outlives no run: whatever is still open when the room unmounts
  // is closed here.
  const { teardownAll } = connections;
  useEffect(() => teardownAll, [teardownAll]);

  const cancel = useCallback(
    () => terminal.finalize({ kind: "local-abort", status: "CANCELED", reason: "user-canceled" }),
    [terminal],
  );

  return { state: room.state, cancel, setProvisionalSelfProfile: room.setProvisionalSelfProfile };
}
