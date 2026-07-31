import { useCallback, useRef } from "react";

import { WebrtcConnection, isForceRelayRequested } from "~/lib/webrtc";
import {
  BULK_CONNECTION_COUNT,
  CONTROL_CONN_INDEX,
  bulkConnIndex,
  type ChannelLabel,
  type ConnectionType,
  type OwnAddress,
} from "~/model/connection.model";
import type { Envelope } from "~/model/signaling.model";
import type { RoomRunContext } from "~/model/room.model";
import { useLatest } from "./latest.hook";

export interface PeerConnectionsOptions {
  send: (envelope: Envelope) => void;
  onPaired: () => void;
  onConnectionType: (type: ConnectionType) => void;
  onFailure: (reason: string) => void;
  onControlOpen: (channel: RTCDataChannel) => void;
  onBulkOpen: (bulkSlot: number, channel: RTCDataChannel) => void;
  onChannelMessage: (label: ChannelLabel, event: MessageEvent) => void;
  onChannelClose: (label: ChannelLabel) => void;
}

export interface PeerConnectionsHandle {
  controlChannel: React.RefObject<RTCDataChannel | null>;
  /** One slot per bulk connection; a hole means that connection's channel has
   * not opened yet. */
  bulkChannels: React.RefObject<(RTCDataChannel | null)[]>;
  createConnections: (iceServers: RTCIceServer[]) => void;
  connectionFor: (connIndex: number) => WebrtcConnection | null;
  teardownAll: () => void;
  sendControlRaw: (raw: string) => void;
  getOwnAddress: () => Promise<OwnAddress>;
}

/**
 * The control connection plus `BULK_CONNECTION_COUNT` bulk connections.
 *
 * Genuine parallelism needs independent SCTP associations, not just
 * independent data channels on one — so each bulk channel gets its own
 * `RTCPeerConnection`, hence its own ICE negotiation and congestion window.
 */
export function usePeerConnections(
  ctx: React.RefObject<RoomRunContext>,
  opts: PeerConnectionsOptions,
): PeerConnectionsHandle {
  const latest = useLatest(opts);

  const controlConnRef = useRef<WebrtcConnection | null>(null);
  const bulkConnsRef = useRef<(WebrtcConnection | null)[]>(
    new Array(BULK_CONNECTION_COUNT).fill(null),
  );
  const controlChannelRef = useRef<RTCDataChannel | null>(null);
  const bulkChannelsRef = useRef<(RTCDataChannel | null)[]>(
    new Array(BULK_CONNECTION_COUNT).fill(null),
  );

  const allConnections = useCallback(
    () =>
      [controlConnRef.current, ...bulkConnsRef.current].filter(
        (c): c is WebrtcConnection => c !== null,
      ),
    [],
  );

  /** Aggregated the same way `TerminalController` combines two peers' `via`:
   * RELAY if any one connection is relayed, else DIRECT if at least one is
   * classified. One relayed bulk connection among several direct ones still
   * means real traffic crossed a relay, so the badge must not read as fully
   * direct. */
  const recomputeConnectionType = useCallback(() => {
    const types = allConnections().map((c) => c.getConnectionType());
    latest.current.onConnectionType(
      types.includes("RELAY") ? "RELAY" : types.includes("DIRECT") ? "DIRECT" : "UNKNOWN",
    );
  }, [allConnections, latest]);

  const teardownAll = useCallback(() => {
    for (const conn of allConnections()) conn.teardown();
  }, [allConnections]);

  const sendControlRaw = useCallback((raw: string) => {
    controlChannelRef.current?.send(raw);
  }, []);

  /** The inverse of the `connIndex` stamped on every outgoing negotiation
   * message: routes an inbound one to the instance that originated it. */
  const connectionFor = useCallback((connIndex: number): WebrtcConnection | null => {
    if (connIndex === CONTROL_CONN_INDEX) return controlConnRef.current;
    return bulkConnsRef.current[connIndex - CONTROL_CONN_INDEX - 1] ?? null;
  }, []);

  const createConnections = useCallback(
    (iceServers: RTCIceServer[]) => {
      const self = ctx.current.self;
      const runId = ctx.current.runId;
      // Idempotent: a second `ice-servers` never builds a second set.
      if (!self || !runId || controlConnRef.current) return;
      const slot = self.slot;
      const forceRelay = isForceRelayRequested();
      const send = (envelope: Envelope) => latest.current.send(envelope);

      controlConnRef.current = new WebrtcConnection({
        slot,
        runId,
        connIndex: CONTROL_CONN_INDEX,
        role: "control",
        iceServers,
        forceRelay,
        send,
        callbacks: {
          onConnectionStateChange: (state) => {
            if (state === "connected") latest.current.onPaired();
          },
          onConnectionTypeChange: recomputeConnectionType,
          onFailure: (reason) => latest.current.onFailure(reason),
          onChannelOpen: (_label, channel) => {
            controlChannelRef.current = channel;
            latest.current.onControlOpen(channel);
          },
          onChannelMessage: (label, event) => latest.current.onChannelMessage(label, event),
          onChannelClose: (label) => latest.current.onChannelClose(label),
        },
      });

      for (let bulkSlot = 0; bulkSlot < BULK_CONNECTION_COUNT; bulkSlot++) {
        bulkConnsRef.current[bulkSlot] = new WebrtcConnection({
          slot,
          runId,
          connIndex: bulkConnIndex(bulkSlot),
          role: "bulk",
          iceServers,
          forceRelay,
          send,
          callbacks: {
            onConnectionTypeChange: recomputeConnectionType,
            onFailure: (reason) => latest.current.onFailure(reason),
            // Each closure already knows its own slot, so opening never has to
            // recover an index from the channel label.
            onChannelOpen: (_label, channel) => {
              bulkChannelsRef.current[bulkSlot] = channel;
              latest.current.onBulkOpen(bulkSlot, channel);
            },
            onChannelMessage: (label, event) => latest.current.onChannelMessage(label, event),
            onChannelClose: (label) => latest.current.onChannelClose(label),
          },
        });
      }
    },
    [ctx, latest, recomputeConnectionType],
  );

  /** `getStats()`-backed, and must never take the initial profile send down
   * with it: a browser-specific hiccup must not strand the run in `pairing`
   * for the full profile-timeout window. */
  const getOwnAddress = useCallback(async (): Promise<OwnAddress> => {
    try {
      return (await controlConnRef.current?.getOwnAddress()) ?? {};
    } catch (err) {
      console.warn("getOwnAddress failed; continuing without it", err);
      return {};
    }
  }, []);

  return {
    controlChannel: controlChannelRef,
    bulkChannels: bulkChannelsRef,
    createConnections,
    connectionFor,
    teardownAll,
    sendControlRaw,
    getOwnAddress,
  };
}
