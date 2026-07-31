/**
 * One `RTCPeerConnection` and one data channel (2.2, 2.3).
 *
 * Bulk throughput comes from running `BULK_CONNECTION_COUNT` of these in
 * parallel — genuinely parallel, unlike several channels on one connection:
 * each gets its own ICE negotiation, DTLS session and SCTP association, hence
 * its own congestion window. The caller fans out; this class only ever knows
 * the one connection it was constructed for, and routing an inbound envelope
 * to the right instance is the caller's job.
 */

import type { Envelope, Slot } from "~/model/signaling.model";
import type { ChannelLabel, ConnectionType, OwnAddress } from "~/model/connection.model";

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
  /** Which of this run's several `RTCPeerConnection`s this instance is —
   * stamped on every outgoing offer/answer/ice-candidate so the peer can
   * route it back to the matching instance on their side. */
  connIndex: number;
  role: ChannelLabel;
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

// Some WebKit versions briefly aggregate `connectionState` to "failed" while
// ICE is still pruning after nomination, then recover on their own. Confirm
// the failure still holds rather than tearing down a working connection.
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

  private readonly connIndex: number;
  private readonly role: ChannelLabel;
  private channel: RTCDataChannel | null = null;

  private producing = true;
  private torndown = false;
  private connectionType: ConnectionType = "UNKNOWN";
  private classifying = false;
  private failureConfirmTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: WebrtcOptions) {
    this.slot = opts.slot;
    this.runId = opts.runId;
    this.connIndex = opts.connIndex;
    this.role = opts.role;
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
        connIndex: this.connIndex,
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

    // Diagnostic only: the more granular, more consistently implemented
    // signal, so a browser-specific disconnect is visible in the console
    // rather than only as an unexplained close on the wire.
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
      // The channel is created here, before the first (and only) offer: a
      // channel added post-connect triggers renegotiation, and there is no
      // renegotiation flow in this design.
      this.wireChannel(
        this.role === "control"
          ? this.pc.createDataChannel("control", { ordered: true })
          : this.pc.createDataChannel("bulk", { ordered: false, maxRetransmits: 0 }),
      );
      void this.startAsOfferer();
    }
  }

  /** This connection's one channel — `control` or `bulk` depending on
   * `role`. `null` until it opens. */
  getChannel(): RTCDataChannel | null {
    return this.channel;
  }

  getConnectionType(): ConnectionType {
    return this.connectionType;
  }

  getConnectionState(): RTCPeerConnectionState {
    return this.pc.connectionState;
  }

  /** Derived from gathered ICE candidates rather than asked of anyone (2.6).
   * Prefers the server-reflexive candidate; the selected pair's local
   * candidate is never used, because on a relayed connection that is the TURN
   * server's address, not this peer's. Absence is a valid answer. */
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

  /** Stops new production without clearing data already handed to
   * measurement modules, and without closing the channels the terminal
   * handoff still needs. */
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
      this.channel?.close();
    } catch {
      // already closed
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
      this.send({ type: "offer", runId: this.runId, connIndex: this.connIndex, payload: offer });
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
      this.send({ type: "answer", runId: this.runId, connIndex: this.connIndex, payload: answer });
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
    if (this.role === "bulk") channel.binaryType = "arraybuffer";
    this.channel = channel;
    const label = this.role;
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
