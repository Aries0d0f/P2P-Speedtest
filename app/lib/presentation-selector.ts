/**
 * The one selector between the room state and every animated component.
 *
 * Pure and plain-data in: Three.js and Anime.js never see the transport
 * wrapper, data channels, timers, stage orchestrator, or the mutable
 * measurement banks — which makes it mechanically impossible for a render
 * failure to send protocol traffic or perturb a measurement.
 */

import { toGeoPoint } from "~/model/geo.model";
import type { Slot } from "~/model/signaling.model";
import type { Latency, StageProgress } from "~/model/measurement.model";
import { fallbackPeerName, type PeerProfile } from "~/model/peer.model";
import {
  DUPLEX,
  edgeKey,
  isReceiver,
  otherSlot,
  senderSlotFor,
  stageName,
  type StageId,
} from "~/model/stage.model";
import type { ConnectionType } from "~/model/connection.model";
import type {
  LiveTestPresentation,
  LiveTestRoomView,
  PeerView,
  TransferChannel,
  TransferMode,
  TransferToken,
} from "~/model/presentation.model";

export function tokenForRole(mode: TransferMode, role: "receive" | "send"): TransferToken {
  if (mode === "idle") return "--transfer-idle";
  if (mode === "duplex") return "--transfer-duplex";
  return role === "receive" ? "--transfer-receive" : "--transfer-send";
}

/** A withheld field is omitted rather than set to `undefined`, so "absent"
 * reads the same here as it does on the wire and in a stored result. */
function toPeerView(slot: Slot, profile: PeerProfile | null): PeerView {
  return {
    slot,
    name: profile?.name?.trim() || fallbackPeerName(slot),
    ...(profile?.ua ? { ua: profile.ua } : {}),
    ...(profile?.ip ? { ip: profile.ip } : {}),
    ...(profile?.protocol ? { protocol: profile.protocol } : {}),
    ...(profile?.geo ? { geo: profile.geo } : {}),
    location: toGeoPoint(profile?.geo),
    profileKnown: profile !== null,
  };
}

/** Megabits per second from a receiver-observed window. `null` rather than
 * `0` when the window has no duration yet — a gauge must be able to say
 * "measuring" instead of asserting a speed it has not observed. */
export function snapshotMbps(snapshot: StageProgress): number | null {
  if (!Number.isFinite(snapshot.bytes) || !Number.isFinite(snapshot.elapsedMs)) return null;
  if (snapshot.elapsedMs <= 0) return null;
  return (snapshot.bytes * 8) / (snapshot.elapsedMs / 1000) / 1_000_000;
}

export function snapshotLoss(snapshot: StageProgress): number | null {
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
  snapshot: StageProgress | undefined,
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

/** Pure: same input, same output, no I/O, no clock, no mutation of `view`. */
export function selectLiveTestPresentation(
  view: LiveTestRoomView,
  localSlot: Slot,
): LiveTestPresentation {
  const localPeer = toPeerView(localSlot, view.selfProfile);
  const remotePeer = toPeerView(otherSlot(localSlot), view.otherProfile);

  const active = view.phase === "testing";
  const frozen = view.phase === "finalizing" || view.phase === "result";

  // `finalizing` keeps the last stage's channels so the gauge and route hold
  // their final reading instead of blanking mid-sentence; `active` is what
  // stops the particle flow. By `result` the stage is genuinely over and the
  // summary owns the numbers.
  const stageId = active || view.phase === "finalizing" ? view.stageId : null;
  const mode: TransferMode = stageId === null ? "idle" : modeFor(stageId, localSlot);

  // A retained bank from a previous run can never reach a widget.
  const progressUsable = view.runId !== null && view.stageProgress.runId === view.runId;

  const channels: TransferChannel[] =
    stageId === null
      ? []
      : receiverSlotsFor(stageId, localSlot).map((receiverSlot) =>
          channelFor(
            stageId,
            receiverSlot,
            localSlot,
            mode,
            progressUsable ? view.stageProgress.entries[edgeKey(stageId, receiverSlot)] : undefined,
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

function selectLatency(view: LiveTestRoomView): Latency | null {
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

/** The same presentation from a stored result: no stage, no channels, no
 * clock. `localPeerId` is the record's own `metadata.peer-id`; peers are
 * ordered by slot, so its index in `peers` is this browser's slot. */
export function selectStoredResultPresentation(input: {
  /** Stable per record, so the globe resets between two results. */
  runId: string;
  peers: readonly [PeerProfile & { id: string }, PeerProfile & { id: string }];
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
      stageProgress: { runId: null, entries: {} },
      liveLatency: null,
      latencyBaseline: null,
      connectionType: input.connectionType,
      selfProfile: input.peers[localIndex],
      otherProfile: input.peers[localIndex === 0 ? 1 : 0],
    },
    localSlot,
  );
}

/** The screen-reader equivalent of the whole scene, so the canvas can stay
 * `aria-hidden` without any information living only in pixels. */
export function describePresentation(p: LiveTestPresentation): string {
  const parts: string[] = [];
  parts.push(`${p.localPeer.name} (You)${describeLocation(p.localPeer)}`);
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

function describeLocation(peer: PeerView): string {
  if (peer.location) {
    return ` at ${peer.location.lat.toFixed(1)}, ${peer.location.lon.toFixed(1)}`;
  }
  return peer.profileKnown ? " — location not shared" : " — location not received yet";
}
