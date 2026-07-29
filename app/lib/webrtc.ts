/**
 * RTCPeerConnection wrapper (2.2, 2.3). Owns offer/answer negotiation,
 * ICE candidate exchange, both data channels, relay classification, and
 * the stopProducing()/teardown() pair that the room's terminal handoff
 * (2.4) drives without reaching inside measurement modules.
 *
 * Deliberately signaling-transport-agnostic: the caller hands in `send`
 * (writes to the already-open signaling socket) and feeds inbound
 * offer/answer/ice-candidate envelopes to `handleSignalingMessage`. This
 * module never touches the WebSocket itself.
 */

import type { Envelope, Slot } from "./protocol";

export type ConnectionType = "DIRECT" | "RELAY" | "UNKNOWN";

export type ChannelLabel = "control" | "bulk";

/**
 * Bulk transfer runs over this many parallel data channels rather than one
 * (04-throughput-measurement.md revision, performance finding). All of
 * them still multiplex over the single SCTP association a `RTCPeerConnection`
 * gets — this doesn't buy independent congestion windows the way parallel
 * TCP connections do — but it keeps more data "ready to send" across
 * independent per-channel backpressure loops, which measurably reduces
 * idle time between JS callbacks versus a single channel's send loop
 * stalling on one `bufferedamountlow` round trip at a time.
 */
export const BULK_CHANNEL_COUNT = 4;

const BULK_LABEL_PATTERN = /^bulk-(\d+)$/;

function bulkChannelLabel(index: number): string {
  return `bulk-${index}`;
}

/** Returns the channel's bulk index, or `null` if it's not a bulk channel
 * (i.e. it's the control channel). Exported so callers (room.tsx) can
 * recover the same index from `RTCDataChannel.label` without duplicating
 * the parsing rule. */
export function bulkChannelIndex(label: string): number | null {
  const match = BULK_LABEL_PATTERN.exec(label);
  if (!match) return null;
  const index = Number(match[1]);
  return index >= 0 && index < BULK_CHANNEL_COUNT ? index : null;
}

export interface WebrtcCallbacks {
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
  onConnectionTypeChange?: (type: ConnectionType) => void;
  onChannelOpen?: (label: ChannelLabel, channel: RTCDataChannel) => void;
  onChannelMessage?: (label: ChannelLabel, event: MessageEvent) => void;
  onChannelClose?: (label: ChannelLabel) => void;
  /** ICE/negotiation failure, distinct from a clean connectionState change
   * so the room can call `abortPreMeasurement` rather than treat it as an
   * ordinary state transition. */
  onFailure?: (reason: string) => void;
}

export interface WebrtcOptions {
  slot: Slot;
  runId: string;
  iceServers: RTCIceServer[];
  send: (envelope: Envelope) => void;
  callbacks?: WebrtcCallbacks;
  /** Forced-relay testing (2.3): behind a test-only switch, never on by
   * default in production use. */
  forceRelay?: boolean;
}

const CLASSIFICATION_POLL_INTERVAL_MS = 200;
// How long a classification must hold steady before it's reported — the
// selected pair can change moments after `connected`, when a better pair
// wins late (Negotiation contract).
const CLASSIFICATION_SETTLE_WINDOW_MS = 1000;

// Some WebKit/Safari versions aggregate `connectionState` to "failed" for a
// moment while ICE is still pruning/rechecking other candidate pairs after
// nomination, then recover to "connected" on their own without any restart.
// Confirming the failure still holds after a short grace window avoids
// tearing down a connection that was never actually broken.
const CONNECTION_FAILURE_CONFIRM_MS = 3000;

const FORCE_RELAY_QUERY_PARAM = "forceRelay";

/** Test-only switch: `?forceRelay=1` in the URL. Named in code, not left to
 * environment folklore, so the forced-relay browser matrix is reproducible. */
export function isForceRelayRequested(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get(FORCE_RELAY_QUERY_PARAM) === "1";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `RTCStatsReport` is Map-like at runtime but the bundled DOM lib only
 * types `forEach`; collect into a real Map once so callers can use normal
 * lookups. */
function collectStats(report: RTCStatsReport): Map<string, any> {
  const map = new Map<string, any>();
  report.forEach((value, key) => map.set(key, value));
  return map;
}

function findSelectedPair(stats: Map<string, any>): any | null {
  for (const report of stats.values()) {
    if (report.type === "transport" && report.selectedCandidatePairId) {
      const pair = stats.get(report.selectedCandidatePairId);
      if (pair) return pair;
    }
  }
  // Safari doesn't expose a `transport` report with `selectedCandidatePairId`
  // in every version; fall back to the nominated, succeeded pair.
  for (const report of stats.values()) {
    if (report.type === "candidate-pair" && report.nominated && report.state === "succeeded") {
      return report;
    }
  }
  return null;
}

async function classify(pc: RTCPeerConnection): Promise<ConnectionType> {
  const stats = collectStats(await pc.getStats());
  const pair = findSelectedPair(stats);
  if (!pair) return "UNKNOWN";
  const local = stats.get(pair.localCandidateId);
  const remote = stats.get(pair.remoteCandidateId);
  if (!local || !remote) return "UNKNOWN";
  return local.candidateType === "relay" || remote.candidateType === "relay"
    ? "RELAY"
    : "DIRECT";
}

export interface OwnAddress {
  ip?: string;
  protocol?: "IPv4" | "IPv6";
}

function toOwnAddress(address: string): OwnAddress {
  return { ip: address, protocol: address.includes(":") ? "IPv6" : "IPv4" };
}

export class WebrtcConnection {
  private readonly pc: RTCPeerConnection;
  private readonly slot: Slot;
  private readonly runId: string;
  private readonly send: (envelope: Envelope) => void;
  private readonly callbacks: WebrtcCallbacks;

  private remoteDescriptionSet = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];

  private controlChannel: RTCDataChannel | null = null;
  private readonly bulkChannels: (RTCDataChannel | null)[] = new Array(BULK_CHANNEL_COUNT).fill(
    null,
  );

  private producing = true;
  private torndown = false;
  private connectionType: ConnectionType = "UNKNOWN";
  private classifying = false;
  private failureConfirmTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: WebrtcOptions) {
    this.slot = opts.slot;
    this.runId = opts.runId;
    this.send = opts.send;
    this.callbacks = opts.callbacks ?? {};

    this.pc = new RTCPeerConnection({
      iceServers: opts.iceServers,
      iceTransportPolicy: opts.forceRelay ? "relay" : "all",
    });

    this.pc.onicecandidate = (event) => {
      if (!this.producing) return;
      this.send({
        type: "ice-candidate",
        runId: this.runId,
        payload: event.candidate ? event.candidate.toJSON() : null,
      });
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      this.callbacks.onConnectionStateChange?.(state);
      if (state === "connected") {
        this.clearFailureConfirmTimer();
        void this.startClassification();
      } else if (state === "failed") {
        this.scheduleFailureConfirm();
      } else {
        // Any other transition (disconnected, connecting, closed, …)
        // cancels a pending failure confirmation — a "failed" report that
        // moved on to something else clearly wasn't a lasting failure.
        this.clearFailureConfirmTimer();
      }
    };

    // Diagnostic only: `iceConnectionState` is the more granular, more
    // consistently implemented signal across browsers. Logged so a
    // browser-specific disconnect (e.g. Safari/WebKit's looser
    // `connectionState` aggregation) is visible in the console instead of
    // only showing up as an unexplained close on the wire.
    this.pc.oniceconnectionstatechange = () => {
      const iceState = this.pc.iceConnectionState;
      if (iceState === "disconnected" || iceState === "failed") {
        console.warn(
          `webrtc: iceConnectionState=${iceState} (connectionState=${this.pc.connectionState})`,
        );
      }
    };

    // Registered before any offer is applied (required for slot 1: an
    // incoming channel can arrive as soon as the remote description with
    // channels in it is set).
    this.pc.ondatachannel = (event) => {
      this.wireChannel(event.channel);
    };

    if (this.slot === 0) {
      // Every channel is created here, before the first (and only) offer:
      // a channel added post-connect triggers renegotiation, and there is
      // no renegotiation flow in this design.
      this.wireChannel(this.pc.createDataChannel("control", { ordered: true }));
      for (let i = 0; i < BULK_CHANNEL_COUNT; i++) {
        this.wireChannel(
          this.pc.createDataChannel(bulkChannelLabel(i), { ordered: false, maxRetransmits: 0 }),
        );
      }
      void this.startAsOfferer();
    }
  }

  getControlChannel(): RTCDataChannel | null {
    return this.controlChannel;
  }

  /** All `BULK_CHANNEL_COUNT` bulk channels, in index order. Only
   * meaningful once every one of them has opened — callers gate on that
   * themselves (room.tsx waits for `BULK_CHANNEL_COUNT` `onChannelOpen`
   * calls before starting stages), so this never silently returns a
   * partial, misordered set to a caller that assumed otherwise. */
  getBulkChannels(): RTCDataChannel[] {
    return this.bulkChannels.filter((c): c is RTCDataChannel => c !== null);
  }

  getConnectionType(): ConnectionType {
    return this.connectionType;
  }

  getConnectionState(): RTCPeerConnectionState {
    return this.pc.connectionState;
  }

  /** This peer's own address (2.6), derived from its gathered ICE
   * candidates rather than asked of anyone. Prefers the server-reflexive
   * candidate (this browser's address as seen from outside); on a relayed
   * connection the selected pair's local candidate would be the TURN
   * server's address, not this peer's, so it is never used here. Falls
   * back to the host candidate actually in use (same-network pairing, or
   * STUN blocked) and otherwise returns nothing — the schema allows the
   * absence precisely because no server supplies these fields. */
  async getOwnAddress(): Promise<OwnAddress> {
    const stats = collectStats(await this.pc.getStats());

    for (const report of stats.values()) {
      if (report.type === "local-candidate" && report.candidateType === "srflx" && report.address) {
        return toOwnAddress(report.address);
      }
    }

    const pair = findSelectedPair(stats);
    if (pair) {
      const local = stats.get(pair.localCandidateId);
      if (local?.type === "local-candidate" && local.candidateType === "host" && local.address) {
        return toOwnAddress(local.address);
      }
    }

    return {};
  }

  handleSignalingMessage(envelope: Envelope): void {
    switch (envelope.type) {
      case "offer":
        void this.handleOffer(envelope.payload);
        return;
      case "answer":
        void this.handleAnswer(envelope.payload);
        return;
      case "ice-candidate":
        void this.handleRemoteCandidate(envelope.payload);
        return;
      default:
        return;
    }
  }

  /** Prevents new negotiation, stage-control, ping, and bulk production
   * without clearing data already handed to measurement modules. Leaves
   * terminal control messages and signaling `run-finished` untouched —
   * those are sent by higher-level code over channels this call doesn't
   * close. */
  stopProducing(): void {
    this.producing = false;
  }

  /** Closes the peer connection and channels and clears transport queues.
   * Idempotent: safe to call from multiple simultaneous terminal triggers. */
  teardown(): void {
    if (this.torndown) return;
    this.torndown = true;
    this.producing = false;
    this.pendingCandidates = [];
    this.clearFailureConfirmTimer();
    try {
      this.controlChannel?.close();
    } catch {
      // already closed
    }
    for (const channel of this.bulkChannels) {
      try {
        channel?.close();
      } catch {
        // already closed
      }
    }
    try {
      this.pc.close();
    } catch {
      // already closed
    }
  }

  private scheduleFailureConfirm(): void {
    if (this.failureConfirmTimer) return; // already waiting on one
    this.failureConfirmTimer = setTimeout(() => {
      this.failureConfirmTimer = null;
      if (!this.torndown && this.pc.connectionState === "failed") {
        this.callbacks.onFailure?.("ice-failed");
      }
    }, CONNECTION_FAILURE_CONFIRM_MS);
  }

  private clearFailureConfirmTimer(): void {
    if (this.failureConfirmTimer) {
      clearTimeout(this.failureConfirmTimer);
      this.failureConfirmTimer = null;
    }
  }

  private async startAsOfferer(): Promise<void> {
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      if (!this.producing) return;
      this.send({ type: "offer", runId: this.runId, payload: offer });
    } catch {
      this.callbacks.onFailure?.("negotiation-failed");
    }
  }

  private async handleOffer(offer: RTCSessionDescriptionInit): Promise<void> {
    try {
      await this.pc.setRemoteDescription(offer);
      this.remoteDescriptionSet = true;
      await this.flushPendingCandidates();
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      if (!this.producing) return;
      this.send({ type: "answer", runId: this.runId, payload: answer });
    } catch {
      this.callbacks.onFailure?.("negotiation-failed");
    }
  }

  private async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    try {
      await this.pc.setRemoteDescription(answer);
      this.remoteDescriptionSet = true;
      await this.flushPendingCandidates();
    } catch {
      this.callbacks.onFailure?.("negotiation-failed");
    }
  }

  private async handleRemoteCandidate(
    candidate: RTCIceCandidateInit | null,
  ): Promise<void> {
    // A null/empty candidate is an explicit end-of-candidates marker with
    // nothing to add; its absence must never be relied on either, so no
    // state depends on ever receiving one.
    if (candidate === null) return;
    if (!this.remoteDescriptionSet) {
      this.pendingCandidates.push(candidate);
      return;
    }
    await this.addCandidate(candidate);
  }

  private async flushPendingCandidates(): Promise<void> {
    const queued = this.pendingCandidates;
    this.pendingCandidates = [];
    // Sequential and in arrival order, per the negotiation contract.
    for (const candidate of queued) {
      await this.addCandidate(candidate);
    }
  }

  private async addCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    try {
      await this.pc.addIceCandidate(candidate);
    } catch {
      // A malformed or late candidate from an untrusted peer must not take
      // the connection down; it just doesn't open a path.
    }
  }

  private wireChannel(channel: RTCDataChannel): void {
    const index = bulkChannelIndex(channel.label);
    const label: ChannelLabel = index === null ? "control" : "bulk";
    if (index !== null) {
      channel.binaryType = "arraybuffer";
      this.bulkChannels[index] = channel;
    } else {
      this.controlChannel = channel;
    }
    channel.onopen = () => this.callbacks.onChannelOpen?.(label, channel);
    channel.onmessage = (event) => this.callbacks.onChannelMessage?.(label, event);
    channel.onclose = () => this.callbacks.onChannelClose?.(label);
  }

  private async startClassification(): Promise<void> {
    if (this.classifying) return;
    this.classifying = true;
    try {
      let stableSince: number | null = null;
      let lastType: ConnectionType | null = null;
      while (!this.torndown && this.pc.connectionState === "connected") {
        const type = await classify(this.pc);
        if (type === "UNKNOWN") {
          stableSince = null;
          lastType = null;
        } else if (type === lastType) {
          if (stableSince !== null && Date.now() - stableSince >= CLASSIFICATION_SETTLE_WINDOW_MS) {
            this.connectionType = type;
            this.callbacks.onConnectionTypeChange?.(type);
            return;
          }
        } else {
          lastType = type;
          stableSince = Date.now();
        }
        await sleep(CLASSIFICATION_POLL_INTERVAL_MS);
      }
    } finally {
      this.classifying = false;
    }
  }
}
