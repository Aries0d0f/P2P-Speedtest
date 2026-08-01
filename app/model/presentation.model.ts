/**
 * The presentation boundary between the room's live state and every animated
 * widget (6.1).
 *
 * Two invariants carry the whole phase:
 *
 * 1. Every speed shown anywhere comes from a *receiver-observed* snapshot for
 *    a `(runId, stageId, receiverSlot)` edge. There is no field here that
 *    could carry a sender's buffered byte count.
 * 2. Stage names are global (`download` is always slot 0 -> slot 1), but
 *    receive/send colouring is local. The same physical transfer is violet on
 *    the sender's screen and cyan on the receiver's, while the particle
 *    direction is identical on both.
 */

import type { GeoPoint } from "./geo.model";
import type { Slot } from "./signaling.model";
import type { StageId, StageName } from "./stage.model";
import type { ConnectionType } from "./connection.model";
import type { Latency } from "./measurement.model";
import type { DeviceInfo, PeerData } from "./peer.model";
import type { RoomPhase, RoomState } from "./room.model";

/** Relative to *this* browser, never to a slot. */
export type TransferMode = "idle" | "receive" | "send" | "duplex";

/** The four semantic colour tokens defined once in `app.css`. Colour is never
 * the only distinction — every channel also carries a name and an arrow. */
export type TransferToken =
  | "--transfer-receive"
  | "--transfer-send"
  | "--transfer-duplex"
  | "--transfer-idle";

/**
 * A peer as the visualization sees it. Everything here has already been
 * privacy-projected at the sender, so these are exactly the fields that peer
 * chose to disclose — an absent one means withheld, never unknown.
 */
export type PeerView = Pick<
  PeerData,
  "slot" | "name" | "ua" | "device" | "ip" | "protocol" | "geo"
> & {
  /** `geo` narrowed to a usable pair of coordinates: `null` whenever the peer
   * withheld, failed to look up, or has not yet sent them. Never inferred from
   * an IP or any other source. */
  location: GeoPoint | null;
  /** What to draw for this peer: the descriptor it sent, or failing that what
   * its disclosed `ua` gives up — the only two sources, so a peer that shared
   * neither is drawn as unknown rather than as whoever is reading. */
  icon: DeviceInfo | null;
  /** True once this peer's profile has arrived at all, so the UI can say
   * "hidden" rather than "still waiting". */
  profileKnown: boolean;
};

/**
 * One directed edge currently being measured, as seen by this browser.
 * `senderSlot`/`receiverSlot` are the *physical* direction and are identical
 * on both peers' screens; `role` and `token` are this browser's local view.
 */
export interface TransferChannel {
  stageId: StageId;
  senderSlot: Slot;
  receiverSlot: Slot;
  role: "receive" | "send";
  token: TransferToken;
  /** Short label so the two duplex streams stay tellable apart without
   * colour ("You receive" / "You send"). */
  label: string;
  /** Receiver-observed megabits per second, or `null` when no usable progress
   * snapshot exists yet. Never substituted with zero: "no reading" and
   * "measured 0 Mbps" are different facts. */
  mbps: number | null;
  loss: number | null;
  /** Stable identity for graph series and gauge channels. */
  key: string;
  /** Opaque identity of the *underlying snapshot*: two renders carrying the
   * same `sampleKey` describe the same progress event, so the graph can drop
   * the duplicate instead of drawing a second point. */
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
  /** Empty during latency warm-up and stage gaps, one entry for a directional
   * stage, two for duplex. Never summed or averaged. */
  channels: TransferChannel[];
  localPeer: PeerView;
  remotePeer: PeerView;
  latency: Latency | null;
  connectionType: ConnectionType;
}

/**
 * Exactly the slice of `RoomState` the selector reads — derived, so a field
 * added to the room can never silently reach a widget.
 *
 * Note what is absent: no `RTCDataChannel`, no `WebrtcConnection`, no
 * `StageOrchestrator`, no timer handle, and no sender-side byte counter.
 * `test-visualization.test.ts` asserts that this stays true.
 */
export type LiveTestRoomView = Pick<
  RoomState,
  | "runId"
  | "phase"
  | "stageId"
  | "stageProgress"
  | "liveLatency"
  | "latencyBaseline"
  | "connectionType"
  | "selfProfile"
  | "otherProfile"
>;
