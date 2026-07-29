/**
 * Signaling envelope (S2). `{ type, runId, payload }` is the whole message
 * set and is meant to stay that way — every type is either the DO telling a
 * peer something about the room, a lifecycle-only acknowledgement, or an
 * opaque blob relayed between peers. Isomorphic: both the Worker/DO and the
 * browser import this module.
 *
 * `peer-left` is declared for schema completeness but has no trigger in this
 * phase: a departure after a run has started is reported as `run-ended` with
 * `reason: "peer-left"` instead, since S2 makes the room terminal at that
 * point rather than leaving one peer waiting for a replacement.
 */

export type Slot = 0 | 1;

export type RunEndedReason =
  | "peer-left"
  | "expired"
  | "complete"
  | "finalization-timeout";

export interface TestConfigPayload {
  maxDurationMs: number;
  maxBytes: number;
  chunkBytes: number;
}

export interface PeerAssignedPayload {
  slot: Slot;
  peerId: string;
  expiresAt: string;
}

export interface PeerJoinedPayload {
  slot: Slot;
  peerId: string;
}

export interface PeerLeftPayload {
  slot: Slot;
}

export interface RunStartedPayload {
  peers: [{ slot: 0; peerId: string }, { slot: 1; peerId: string }];
}

export interface RunEndedPayload {
  reason: RunEndedReason;
}

// Phase 2 payloads. offer/answer/ice-candidate are SDP/ICE data relayed
// verbatim between peers — the DO never inspects their contents, only
// `isEnvelope`'s structural check and the run-scoping in `relayIfCurrentRun`
// apply to them.
export interface IceServersPayload {
  iceServers: RTCIceServer[];
}
export type OfferPayload = RTCSessionDescriptionInit;
export type AnswerPayload = RTCSessionDescriptionInit;
// `null` is an explicit end-of-candidates marker; not every browser sends
// one, so its absence must never be relied on (see 02-webrtc-connection.md).
export type IceCandidatePayload = RTCIceCandidateInit | null;

export type Envelope =
  | { type: "peer-assigned"; runId: null; payload: PeerAssignedPayload }
  | { type: "peer-joined"; runId: string | null; payload: PeerJoinedPayload }
  | { type: "peer-left"; runId: string | null; payload: PeerLeftPayload }
  | { type: "ping"; runId: string | null; payload: Record<string, never> }
  | { type: "pong"; runId: string | null; payload: Record<string, never> }
  | { type: "run-started"; runId: string; payload: RunStartedPayload }
  | { type: "run-ended"; runId: string | null; payload: RunEndedPayload }
  | { type: "run-finished"; runId: string; payload: Record<string, never> }
  | { type: "ice-servers"; runId: string; payload: IceServersPayload }
  | { type: "test-config"; runId: null; payload: TestConfigPayload }
  | { type: "offer"; runId: string; payload: OfferPayload }
  | { type: "answer"; runId: string; payload: AnswerPayload }
  | { type: "ice-candidate"; runId: string; payload: IceCandidatePayload };

export type EnvelopeType = Envelope["type"];

/**
 * Structural check only; per-type payload shape is not validated here.
 * `payload` itself is intentionally unconstrained: offer/answer/ice-candidate
 * carry an opaque blob relayed verbatim, which need not be a JSON object.
 */
export function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.type === "string" &&
    (v.runId === null || typeof v.runId === "string") &&
    "payload" in v
  );
}

/**
 * WebSocket close code for the hard-expiry path, distinct from a normal
 * closure so the room page can show "this room expired" even if the
 * `run-ended` message itself is lost.
 */
export const EXPIRED_CLOSE_CODE = 4000;
