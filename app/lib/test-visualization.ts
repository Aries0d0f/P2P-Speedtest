/**
 * The presentation boundary between the room's live test state and every
 * animated widget (06-live-test-visualization 6.1).
 *
 * `selectLiveTestPresentation` is pure and its input is plain data. Three.js
 * and Anime.js never see the transport wrapper, data channels, timers, stage
 * orchestrator, or the mutable measurement banks — which makes it
 * mechanically impossible for a render failure to send protocol traffic or
 * perturb a measurement.
 *
 * Two invariants carry the whole phase:
 *
 * 1. Every speed shown anywhere comes from Phase 4's *receiver-observed*
 *    snapshot for a `(runId, stageId, receiverSlot)` edge. There is no field
 *    here that could carry a sender's buffered byte count.
 * 2. Stage names are global (`download` is always slot 0 -> slot 1), but
 *    receive/send colouring is local. The same physical transfer is violet on
 *    the sender's screen and cyan on the receiver's, while the particle
 *    direction is identical on both.
 */

import type { GeoInfo } from "~/lib/geo";
import type { StageProgressSnapshot } from "~/lib/control-channel";
import type { LiveLatency, Aggregate } from "~/lib/latency";
import { fallbackPeerName } from "~/lib/peer-profile";
import {
  DUPLEX,
  edgeKey,
  isReceiver,
  otherSlot,
  senderSlotFor,
  stageName,
  type Slot,
  type StageId,
  type StageName,
} from "~/lib/stage";
import type { ConnectionType } from "~/lib/webrtc";

export type RoomPhase =
  | "waiting"
  | "pairing"
  | "paired"
  | "testing"
  | "finalizing"
  | "result";

/** Relative to *this* browser, never to a slot. */
export type TransferMode = "idle" | "receive" | "send" | "duplex";

/** The four semantic colour tokens defined once in `app.css`. Colour is never
 * the only distinction — every channel also carries a name and an arrow. */
export type TransferToken =
  | "--transfer-receive"
  | "--transfer-send"
  | "--transfer-duplex"
  | "--transfer-idle";

/** A validated pair of coordinates that a peer actually chose to share. */
export interface VisualLocation {
  lat: number;
  lon: number;
}

export interface VisualPeer {
  slot: Slot;
  /** Display name, or the S6 slot-based fallback. */
  name: string;
  /** `null` whenever the peer withheld, failed to look up, or has not yet
   * sent coordinates. Never inferred from an IP or any other source. */
  location: VisualLocation | null;
  /** True once this peer's profile has arrived at all, so the UI can say
   * "hidden" rather than "still waiting". */
  profileKnown: boolean;
}

/**
 * One directed edge currently being measured, as seen by this browser.
 * `senderSlot`/`receiverSlot` are the *physical* direction and are identical
 * on both peers' screens; `role` and `token` are this browser's local view.
 */
export interface TransferChannel {
  stageId: StageId;
  senderSlot: Slot;
  receiverSlot: Slot;
  /** This browser's relationship to the edge. */
  role: "receive" | "send";
  token: TransferToken;
  /** Short label so the two duplex streams stay tellable apart without
   * colour ("You receive" / "You send"). */
  label: string;
  /** Receiver-observed megabits per second, or `null` when no usable
   * progress snapshot exists yet. Never substituted with zero: "no reading"
   * and "measured 0 Mbps" are different facts. */
  mbps: number | null;
  /** Receiver-observed loss as a fraction in [0, 1], or `null`. */
  loss: number | null;
  /** Stable identity for graph series and gauge channels. */
  key: string;
  /**
   * Opaque identity of the *underlying snapshot*. Two renders that carry the
   * same `sampleKey` describe the same Phase 4 progress event, so the graph
   * can drop the duplicate instead of drawing a second point. `null` when
   * there is no snapshot yet.
   */
  sampleKey: string | null;
}

export interface LiveTestPresentation {
  /** Everything below is scoped to this run; a change means reset. */
  runId: string | null;
  phase: RoomPhase;
  /** The visualization should be mounted and live. */
  active: boolean;
  /** Hold the last frame instead of animating (finalizing / result). */
  frozen: boolean;
  stageId: StageId | null;
  stageName: StageName | null;
  mode: TransferMode;
  /** Empty during latency warm-up and stage gaps, one entry for a
   * directional stage, two for duplex. Never summed or averaged. */
  channels: TransferChannel[];
  localPeer: VisualPeer;
  remotePeer: VisualPeer;
  latency: { rttMs: number; jitterMs: number | null } | null;
  connectionType: ConnectionType;
}

/** A minimal projection of a peer profile: exactly the fields a marker and
 * its label need. Deliberately not `ReceivedPeerProfile` — the selector has
 * no reason to see an IP or user-agent. Only `geo.lat`/`geo.lon` are read;
 * an Anonymous profile's `proxy`/`hosting`-only geo yields no marker. */
export interface VisualProfileInput {
  name?: string;
  geo?: GeoInfo;
}

/**
 * The plain-data view the room route hands the selector.
 *
 * Note what is absent: no `RTCDataChannel`, no `WebrtcConnection`, no
 * `StageOrchestrator`, no timer handle, and no sender-side byte counter.
 * `test-visualization.test.ts` asserts that this stays true.
 */
export interface LiveTestRoomView {
  runId: string | null;
  phase: RoomPhase;
  stageId: StageId | null;
  /** The run `progress` was observed during. A mismatch with `runId` means
   * a caller retained a stale bank; it is dropped rather than displayed. */
  progressRunId: string | null;
  /** Keyed by `edgeKey(stageId, receiverSlot)` — Phase 4's normalized,
   * receiver-observed live snapshots. */
  progress: Readonly<Record<string, StageProgressSnapshot>>;
  liveLatency: LiveLatency | null;
  /** `undefined` while the latency sub-phase is still running, `null` when it
   * finalized without a usable aggregate. */
  latencyBaseline: Aggregate | null | undefined;
  connectionType: ConnectionType;
  /** The profile *as this browser sent it* — already privacy-projected, so
   * both peers' globes agree on which markers exist. */
  localProfile: VisualProfileInput | null;
  remoteProfile: VisualProfileInput | null;
}

export function tokenForRole(mode: TransferMode, role: "receive" | "send"): TransferToken {
  if (mode === "idle") return "--transfer-idle";
  if (mode === "duplex") return "--transfer-duplex";
  return role === "receive" ? "--transfer-receive" : "--transfer-send";
}

/** Coordinates are only usable if they are finite and in range. An
 * out-of-range or non-finite value means "unavailable"; it is never clamped
 * into a plausible-looking but false location. */
export function toVisualLocation(
  geo: Pick<GeoInfo, "lat" | "lon"> | undefined | null,
): VisualLocation | null {
  if (!geo) return null;
  const { lat, lon } = geo;
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

function toVisualPeer(slot: Slot, profile: VisualProfileInput | null): VisualPeer {
  return {
    slot,
    name: profile?.name?.trim() || fallbackPeerName(slot),
    location: toVisualLocation(profile?.geo),
    profileKnown: profile !== null,
  };
}

/** Megabits per second from a receiver-observed window. `null` rather than
 * `0` when the window has no duration yet — a gauge must be able to say
 * "measuring" instead of asserting a speed it has not observed. */
export function snapshotMbps(snapshot: StageProgressSnapshot): number | null {
  if (!Number.isFinite(snapshot.bytes) || !Number.isFinite(snapshot.elapsedMs)) return null;
  if (snapshot.elapsedMs <= 0) return null;
  return (snapshot.bytes * 8) / (snapshot.elapsedMs / 1000) / 1_000_000;
}

export function snapshotLoss(snapshot: StageProgressSnapshot): number | null {
  const seen = snapshot.chunksSeen;
  const highest = snapshot.highestSeqPlusOne;
  if (!Number.isFinite(seen) || !Number.isFinite(highest) || highest <= 0) return null;
  const loss = 1 - seen / highest;
  if (!Number.isFinite(loss)) return null;
  return Math.min(1, Math.max(0, loss));
}

function channelFor(
  stageId: StageId,
  receiverSlot: Slot,
  localSlot: Slot,
  mode: TransferMode,
  snapshot: StageProgressSnapshot | undefined,
): TransferChannel {
  const role: "receive" | "send" = receiverSlot === localSlot ? "receive" : "send";
  return {
    stageId,
    // Derived from the receiver alone, exactly like Phase 4's edge identity —
    // never from a peer-supplied direction field.
    senderSlot: senderSlotFor(receiverSlot),
    receiverSlot,
    role,
    token: tokenForRole(mode, role),
    label: role === "receive" ? "You receive" : "You send",
    mbps: snapshot ? snapshotMbps(snapshot) : null,
    loss: snapshot ? snapshotLoss(snapshot) : null,
    key: edgeKey(stageId, receiverSlot),
    sampleKey: snapshot ? `${snapshot.elapsedMs}:${snapshot.bytes}:${snapshot.chunksSeen}` : null,
  };
}

function modeFor(stageId: StageId, localSlot: Slot): TransferMode {
  if (stageId === DUPLEX) return "duplex";
  return isReceiver(stageId, localSlot) ? "receive" : "send";
}

/** The receiver slots a stage produces edges for, in a stable order: for
 * duplex, this browser's own receive edge comes first so the gauge's primary
 * channel is the one the user is most likely to look for. */
function receiverSlotsFor(stageId: StageId, localSlot: Slot): Slot[] {
  if (stageId === DUPLEX) return [localSlot, otherSlot(localSlot)];
  return [isReceiver(stageId, localSlot) ? localSlot : otherSlot(localSlot)];
}

/**
 * The one selector between the room state and every animated component.
 *
 * Pure: same input, same output, no I/O, no clock, no mutation of `view`.
 */
export function selectLiveTestPresentation(
  view: LiveTestRoomView,
  localSlot: Slot,
): LiveTestPresentation {
  const localPeer = toVisualPeer(localSlot, view.localProfile);
  const remotePeer = toVisualPeer(otherSlot(localSlot), view.remoteProfile);

  const active = view.phase === "testing";
  const frozen = view.phase === "finalizing" || view.phase === "result";

  // `finalizing` keeps the last stage's channels so the gauge and route hold
  // their final reading instead of blanking mid-sentence; `active` is what
  // stops the particle flow. By `result` the stage is genuinely over and the
  // summary owns the numbers.
  const stageId = active || view.phase === "finalizing" ? view.stageId : null;
  const mode: TransferMode = stageId === null ? "idle" : modeFor(stageId, localSlot);

  // A retained bank from a previous run can never reach a widget.
  const progressUsable = view.runId !== null && view.progressRunId === view.runId;

  const channels: TransferChannel[] =
    stageId === null
      ? []
      : receiverSlotsFor(stageId, localSlot).map((receiverSlot) =>
          channelFor(
            stageId,
            receiverSlot,
            localSlot,
            mode,
            progressUsable ? view.progress[edgeKey(stageId, receiverSlot)] : undefined,
          ),
        );

  return {
    runId: view.runId,
    phase: view.phase,
    active,
    frozen,
    stageId,
    stageName: stageId === null ? null : stageName(stageId),
    mode,
    channels,
    localPeer,
    remotePeer,
    latency: selectLatency(view),
    connectionType: view.connectionType,
  };
}

function selectLatency(view: LiveTestRoomView): { rttMs: number; jitterMs: number | null } | null {
  // The finalized baseline supersedes the live reading once Phase 3 hands
  // off; `null` there means "measured, but not enough samples", which is not
  // the same as "no reading yet" and must not fall back to a stale live one.
  if (view.latencyBaseline !== undefined) {
    return view.latencyBaseline === null
      ? null
      : { rttMs: view.latencyBaseline.rttMs, jitterMs: view.latencyBaseline.jitterMs };
  }
  if (!view.liveLatency) return null;
  return { rttMs: view.liveLatency.rttMs, jitterMs: view.liveLatency.jitterMs };
}

/**
 * The same presentation, built from a stored result instead of a live room
 * (S7): no stage, no channels, no clock — just the two peers and whichever
 * locations they chose to share at the time, so a saved result can show the
 * same globe and route the run itself did.
 *
 * `localPeerId` is the record's own `metadata.peer-id`; peers are ordered by
 * slot, so its index in `peers` is this browser's slot.
 */
export function selectStoredResultPresentation(input: {
  /** Stable per record, so the globe resets between two results. */
  runId: string;
  peers: readonly [VisualProfileInput & { id: string }, VisualProfileInput & { id: string }];
  localPeerId: string;
  connectionType: ConnectionType;
}): LiveTestPresentation {
  const localIndex = input.peers[1].id === input.localPeerId ? 1 : 0;
  const localSlot: Slot = localIndex === 1 ? 1 : 0;

  return selectLiveTestPresentation(
    {
      runId: input.runId,
      phase: "result",
      stageId: null,
      progressRunId: null,
      progress: {},
      liveLatency: null,
      latencyBaseline: null,
      connectionType: input.connectionType,
      localProfile: input.peers[localIndex],
      remoteProfile: input.peers[localIndex === 0 ? 1 : 0],
    },
    localSlot,
  );
}

/**
 * The screen-reader equivalent of the whole scene: peers, their available
 * locations, the current stage, the physical direction, and each channel's
 * live number. Kept here so the canvas can stay `aria-hidden` without any
 * information living only in pixels.
 */
export function describePresentation(p: LiveTestPresentation): string {
  const parts: string[] = [];
  parts.push(`${p.localPeer.name} (you)${describeLocation(p.localPeer)}`);
  parts.push(`${p.remotePeer.name}${describeLocation(p.remotePeer)}`);

  if (p.stageName === null) {
    parts.push(p.active ? "Measuring latency" : "No transfer in progress");
  } else {
    parts.push(`Stage: ${p.stageName}`);
    for (const channel of p.channels) {
      const from = channel.senderSlot === p.localPeer.slot ? p.localPeer.name : p.remotePeer.name;
      const to = channel.receiverSlot === p.localPeer.slot ? p.localPeer.name : p.remotePeer.name;
      const speed = channel.mbps === null ? "no reading yet" : `${channel.mbps.toFixed(1)} Mbps`;
      parts.push(`${from} to ${to}: ${speed}`);
    }
  }

  if (p.latency) {
    const jitter = p.latency.jitterMs === null ? "" : `, jitter ${p.latency.jitterMs.toFixed(1)} ms`;
    parts.push(`Round trip ${p.latency.rttMs.toFixed(0)} ms${jitter}`);
  }
  return parts.join(". ") + ".";
}

function describeLocation(peer: VisualPeer): string {
  if (peer.location) {
    return ` at ${peer.location.lat.toFixed(1)}, ${peer.location.lon.toFixed(1)}`;
  }
  return peer.profileKnown ? " — location not shared" : " — location not received yet";
}
