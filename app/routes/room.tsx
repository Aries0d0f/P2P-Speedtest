import { useEffect, useRef, useState } from "react";
import { BsCopy } from "react-icons/bs";
import { useLocation } from "react-router";
import { ConnectionBadge } from "~/components/ConnectionBadge";
import { ProfileFields } from "~/components/ProfileFields";
import { ShareActions } from "~/components/ShareActions";
import type { GeoInfo } from "~/lib/geo";
import { fetchGeo } from "~/lib/geo";
import {
  decodeLatencyMessage,
  LatencySession,
  type Aggregate,
  type LiveLatency,
} from "~/lib/latency";
import {
  decodeStageMessage,
  StageOrchestrator,
  TerminalController,
  type FinalizeTrigger,
  type ResultSharePayload,
  type StageProgressSnapshot,
  type TerminalOutcome,
  type TerminalPeerInfo,
} from "~/lib/control-channel";
import {
  buildEnrichmentProfileMessage,
  buildInitialProfileMessage,
  decodeProfileEnvelope,
  defaultProfile,
  encodeProfileEnvelope,
  saveProfile,
  sanitizeIncomingProfile,
  validateInitialProfile,
  type ConfirmedProfile,
  type PeerProfileMessage,
  type ReceivedPeerProfile,
} from "~/lib/peer-profile";
import {
  EXPIRED_CLOSE_CODE,
  type Envelope,
  type Slot,
  type TestConfigPayload,
} from "~/lib/protocol";
import { slugToToken, tokenToEmojiKey, tokenToSlug } from "~/lib/room-token";
import { edgeKey, stageName, type StageId } from "~/lib/stage";
import { parseBulkFrame } from "~/lib/throughput";
import type { ChannelLabel, ConnectionType } from "~/lib/webrtc";
import {
  BULK_CONNECTION_COUNT,
  CONTROL_CONN_INDEX,
  WebrtcConnection,
  bulkConnIndex,
  isForceRelayRequested,
} from "~/lib/webrtc";

import type { Route } from "./+types/room";

export function meta({}: Route.MetaArgs) {
  return [{ title: "P2P Speedtest — Room" }];
}

interface PeerInfo {
  slot: Slot;
  peerId: string;
}

type Phase = "waiting" | "pairing" | "paired" | "testing" | "finalizing" | "result";

interface TerminalState {
  reason: string;
}

const USER_AGENT = typeof navigator !== "undefined" ? navigator.userAgent : "";

// A missing/invalid initial profile must not strand the room forever —
// this bounds how long `pairing` waits before treating it as a failure
// (2.6's testing-barrier prerequisite).
const PROFILE_TIMEOUT_MS = 20_000;

// Longer than Phase 1's ~5-second one-ack `run-ended` deadline (4.4 step 6):
// how long this peer keeps transport open after its own local finalization
// completes, waiting for the DO's `run-ended`, before tearing down anyway.
const LIFECYCLE_GRACE_MS = 8_000;

const TERMINAL_COPY: Record<string, string> = {
  "peer-left": "The other peer disconnected.",
  expired: "This room expired.",
  complete: "The test finished.",
  "finalization-timeout": "The test could not finish in time.",
  "ice-failed": "Couldn't establish a connection.",
  "negotiation-failed": "Couldn't establish a connection.",
  "profile-timeout": "The other peer never confirmed who they are.",
  "channel-closed": "The connection was lost before pairing finished.",
  "latency-ready-timeout": "The other peer's latency measurement never arrived.",
};

function terminalMessage(reason: string): string {
  return TERMINAL_COPY[reason] ?? `The room ended (${reason}).`;
}

// Expiry reads as "this room expired," not a connection error; genuine
// local/negotiation failures read as an error; a clean peer-left/complete
// reads as neutral news rather than either.
function terminalTone(reason: string): "expired" | "error" | "neutral" {
  if (reason === "expired") return "expired";
  if (
    reason === "ice-failed" ||
    reason === "negotiation-failed" ||
    reason === "profile-timeout" ||
    reason === "channel-closed" ||
    reason === "finalization-timeout" ||
    reason === "latency-ready-timeout"
  ) {
    return "error";
  }
  return "neutral";
}

function formatMbps(bytes: number, elapsedMs: number): string {
  if (elapsedMs <= 0) return "0.0";
  return ((bytes * 8) / (elapsedMs / 1000) / 1_000_000).toFixed(1);
}

function formatSpeed(bitsPerSecond: number): string {
  return (bitsPerSecond / 1_000_000).toFixed(1);
}

const RESULT_STATUS_COPY: Record<string, string> = {
  SUCCEED: "Test complete.",
  FAILED: "The test failed.",
  CANCELED: "The test was canceled.",
};

function ResultSummary({
  outcome,
  onNewRoom,
}: {
  outcome: TerminalOutcome;
  onNewRoom: () => void;
}) {
  const data = outcome.record?.data;
  return (
    <>
      <p
        className={
          outcome.status === "FAILED"
            ? "text-red-600 dark:text-red-400"
            : "text-gray-700 dark:text-gray-200"
        }
      >
        {RESULT_STATUS_COPY[outcome.status] ?? outcome.status}
      </p>
      {data && <ConnectionBadge type={data.via} />}
      {data?.bandwidth.directional && data.bandwidth.directional.length > 0 && (
        <div className="flex flex-col items-center gap-1 text-sm text-gray-700 dark:text-gray-200">
          <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Directional
          </p>
          {data.bandwidth.directional.map((edge, i) => (
            <p key={i}>
              {formatSpeed(edge.speed)} Mbps · {edge.latency.toFixed(0)} ms · loss{" "}
              {(edge.loss * 100).toFixed(2)}%
            </p>
          ))}
        </div>
      )}
      {data?.bandwidth.duplex && data.bandwidth.duplex.length > 0 && (
        <div className="flex flex-col items-center gap-1 text-sm text-gray-700 dark:text-gray-200">
          <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Duplex</p>
          {data.bandwidth.duplex.map((edge, i) => (
            <p key={i}>
              {formatSpeed(edge.speed)} Mbps · {edge.latency.toFixed(0)} ms · loss{" "}
              {(edge.loss * 100).toFixed(2)}%
            </p>
          ))}
        </div>
      )}
      {outcome.record ? (
        <ShareActions result={outcome.record} />
      ) : (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          The result couldn't be saved on this device.
        </p>
      )}
      <button
        type="button"
        onClick={onNewRoom}
        className="rounded-full border border-gray-300 px-4 py-2 text-sm font-medium text-gray-900 dark:border-gray-600 dark:text-gray-100"
      >
        Start a new room
      </button>
    </>
  );
}

function geoSummary(geo: GeoInfo): string | null {
  const place = [geo.city, geo.regionName, geo.country].filter(Boolean);
  if (place.length > 0) return place.join(", ");
  if (geo.proxy !== undefined || geo.hosting !== undefined) {
    const bits: string[] = [];
    if (geo.proxy) bits.push("proxy/VPN");
    if (geo.hosting) bits.push("hosting network");
    return bits.length > 0 ? bits.join(", ") : "residential network";
  }
  return null;
}

/**
 * A random, per-tab, per-room nonce persisted in sessionStorage. It exists
 * only so a refresh of this exact tab reconnects into the same slot instead
 * of racing its own about-to-close socket and pairing with itself; it is
 * never shared with the other peer and never restores any application
 * state (S3 still issues a fresh peerId on every accept).
 */
function getTabSessionId(slug: string): string {
  const key = `p2p-speedtest:room-session:${slug}`;
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;
  const created = crypto.randomUUID();
  sessionStorage.setItem(key, created);
  return created;
}

function OtherPeerSummary({ profile }: { profile: ReceivedPeerProfile }) {
  const geo = profile.geo ? geoSummary(profile.geo) : null;
  return (
    <div className="flex flex-col gap-1 text-center">
      <p className="text-base font-medium text-gray-900 dark:text-gray-100">
        {profile.name}
      </p>
      {profile.ua && (
        <p className="text-xs text-gray-500 dark:text-gray-400">{profile.ua}</p>
      )}
      {profile.ip && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {profile.ip}
          {profile.protocol ? ` (${profile.protocol})` : ""}
        </p>
      )}
      {geo && <p className="text-xs text-gray-500 dark:text-gray-400">{geo}</p>}
    </div>
  );
}

export default function Room({ params }: Route.ComponentProps) {
  const token = slugToToken(params.slug);
  const location = useLocation();
  const locationProfile =
    (location.state as { profile?: ConfirmedProfile } | null | undefined)?.profile ?? null;

  // Both create-and-join-from-home (profile arrives via router state) and a
  // pasted room link (no router state) must confirm the same profile
  // before a socket ever opens (S8) — the gate below covers the second case
  // with the same fields home.tsx uses.
  const [confirmedProfile, setConfirmedProfile] = useState<ConfirmedProfile | null>(
    locationProfile,
  );
  // Only used by the direct-link gate below; harmless to load unconditionally
  // (defaultProfile is a fast localStorage read plus a UA parse, never a
  // network call) — undefined until it resolves, same pattern as home.tsx.
  const [gateProfile, setGateProfile] = useState<ConfirmedProfile>();
  useEffect(() => {
    defaultProfile(USER_AGENT).then(setGateProfile);
  }, []);

  const [phase, setPhase] = useState<Phase>("waiting");
  const [terminal, setTerminal] = useState<TerminalState | null>(null);
  const [self, setSelf] = useState<(PeerInfo & { expiresAt: string }) | null>(null);
  const [other, setOther] = useState<PeerInfo | null>(null);
  const [connectionType, setConnectionType] = useState<ConnectionType>("UNKNOWN");
  const [otherProfile, setOtherProfile] = useState<ReceivedPeerProfile | null>(null);
  const [liveLatency, setLiveLatency] = useState<LiveLatency | null>(null);
  // undefined: the latency sub-phase hasn't finalized yet; null: it finalized
  // but no usable aggregate came out of it (< 3 samples).
  const [latencyBaseline, setLatencyBaseline] = useState<Aggregate | null | undefined>(undefined);
  const [currentStage, setCurrentStage] = useState<StageId | null>(null);
  const [stageProgress, setStageProgress] = useState<Record<string, StageProgressSnapshot>>({});
  const [terminalResult, setTerminalResult] = useState<TerminalOutcome | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  // 04-throughput revision: genuine parallelism needs independent SCTP
  // associations, not just independent data channels on one — so bulk
  // transfer runs over `BULK_CONNECTION_COUNT` separate RTCPeerConnections
  // rather than one connection carrying several channels. `controlConnRef`
  // is connIndex 0; `bulkConnsRef[i]` is connIndex `bulkConnIndex(i)`.
  const controlConnRef = useRef<WebrtcConnection | null>(null);
  const bulkConnsRef = useRef<(WebrtcConnection | null)[]>(
    new Array(BULK_CONNECTION_COUNT).fill(null),
  );
  const latencySessionRef = useRef<LatencySession | null>(null);
  const runIdRef = useRef<string | null>(null);
  const selfRef = useRef<PeerInfo | null>(null);
  const otherSlotRef = useRef<Slot | null>(null);
  const otherPeerIdRef = useRef<string | null>(null);
  const otherProfileRef = useRef<ReceivedPeerProfile | null>(null);
  const connectionTypeRef = useRef<ConnectionType>("UNKNOWN");
  const phaseRef = useRef<Phase>("waiting");
  const terminalRef = useRef(false);
  const initialSentRef = useRef(false);
  const initialReceivedRef = useRef(false);
  const profileTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Phase 4 (S5 gate, 4.4)
  const controlChannelRef = useRef<RTCDataChannel | null>(null);
  // Indexed by bulk connection slot (0..BULK_CONNECTION_COUNT-1, matching
  // `bulkConnsRef`) — a hole means that connection's channel hasn't opened
  // yet.
  const bulkChannelsRef = useRef<(RTCDataChannel | null)[]>(
    new Array(BULK_CONNECTION_COUNT).fill(null),
  );
  const testConfigRef = useRef<TestConfigPayload | null>(null);
  const latencyHandoffFiredRef = useRef(false);
  const latencyReadyRef = useRef(false);
  const stageOrchestratorRef = useRef<StageOrchestrator | null>(null);
  const terminalControllerRef = useRef<TerminalController | null>(null);
  const finalizationStartedRef = useRef(false);
  const lifecycleGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Slot 0's canonical run timestamp (S6) — this peer's own if it is slot 0,
  // otherwise copied from the other peer's validated initial profile.
  const runTimestampRef = useRef<string | null>(null);
  // The exact profile fields last sent to the peer (post-privacy-filtering),
  // so `TerminalController`'s own `peers[]` entry matches what the other
  // side received rather than re-deriving privacy logic at finalize time.
  const selfProfileRef = useRef<PeerProfileMessage | null>(null);
  const cancelTestRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (token === null || confirmedProfile === null) return;
    // Re-bound as its own const: TS function declarations are hoisted, so
    // narrowing on the `useState` value above doesn't reach into them —
    // this binding carries the non-null type into every nested function
    // below without a cast at each call site.
    const profile: ConfirmedProfile = confirmedProfile;

    // The websocket message handler's closures are set up once per effect
    // run, so plain `phase` state (which doesn't retrigger this effect)
    // would read stale — `updatePhase` keeps a ref in sync for the run-ended
    // and channel-close handlers below to check against.
    function updatePhase(next: Phase) {
      phaseRef.current = next;
      setPhase(next);
    }

    function enterTerminal(reason: string) {
      if (terminalRef.current) return;
      terminalRef.current = true;
      if (profileTimeoutRef.current) {
        clearTimeout(profileTimeoutRef.current);
        profileTimeoutRef.current = null;
      }
      setTerminal({ reason });
    }

    // A local ICE/negotiation failure, a missing/invalid initial profile,
    // or the control channel closing before pairing finishes all end the
    // DO's run — merely closing the peer connection would leave the
    // signaling socket occupying its slot and strand the other browser in
    // a live server run. Idempotent: every trigger below can fire more
    // than once (teardown() itself closes the channel, which fires
    // onChannelClose again) and only the first call does anything.
    function abortPreMeasurement(reason: string) {
      if (terminalRef.current) return;
      console.warn(`abortPreMeasurement: ${reason}`);
      enterTerminal(reason);
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          // The specific local `reason` travels in the close reason (well
          // under the 123-byte limit) so a failure is diagnosable from the
          // wire/devtools alone, instead of every trigger reading the same
          // "pre-measurement-failed" regardless of which one actually fired.
          ws.close(4401, reason);
        } catch {
          // already closing
        }
      }
      teardownAllConnections();
    }

    function sendEnvelope(envelope: Envelope) {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify(envelope));
      } catch {
        // socket already gone
      }
    }

    function sendControlRaw(raw: string) {
      controlChannelRef.current?.send(raw);
    }

    function allConnections(): WebrtcConnection[] {
      return [controlConnRef.current, ...bulkConnsRef.current].filter(
        (c): c is WebrtcConnection => c !== null,
      );
    }

    function teardownAllConnections() {
      for (const conn of allConnections()) conn.teardown();
    }

    // The control connection's own `offer`/`answer`/`ice-candidate` messages
    // carry `connIndex: CONTROL_CONN_INDEX`; each bulk connection's carry
    // `bulkConnIndex(i)` — this is the inverse, used to route an inbound
    // signaling message to the one instance among `BULK_CONNECTION_COUNT + 1`
    // that originated the negotiation it's replying to.
    function connectionForIndex(connIndex: number): WebrtcConnection | null {
      if (connIndex === CONTROL_CONN_INDEX) return controlConnRef.current;
      const bulkSlot = connIndex - CONTROL_CONN_INDEX - 1;
      return bulkConnsRef.current[bulkSlot] ?? null;
    }

    // Aggregated across every connection the same way `TerminalController`
    // combines two peers' `via` (4.4): RELAY if any one connection is
    // relayed, else DIRECT if at least one is classified, else UNKNOWN. One
    // relayed bulk connection among several direct ones still means real
    // traffic crossed a relay, so the badge must not read as fully direct.
    function recomputeConnectionType() {
      const types = allConnections().map((c) => c.getConnectionType());
      const type: ConnectionType = types.includes("RELAY")
        ? "RELAY"
        : types.includes("DIRECT")
          ? "DIRECT"
          : "UNKNOWN";
      connectionTypeRef.current = type;
      setConnectionType(type);
    }

    function handleConnectionFailure(reason: string) {
      if (measurementStarted()) {
        finalize({ kind: "local-abort", status: "FAILED", reason });
      } else {
        abortPreMeasurement(reason);
      }
    }

    // Once the stage orchestrator exists, measurement has begun (4.4): every
    // subsequent local/remote failure or close must produce a record rather
    // than the pre-measurement `abortPreMeasurement`/`enterTerminal` path.
    function measurementStarted() {
      return stageOrchestratorRef.current !== null;
    }

    function ensureTerminalController(): TerminalController | null {
      if (terminalControllerRef.current) return terminalControllerRef.current;
      if (!selfRef.current || !runIdRef.current || otherSlotRef.current === null || !runTimestampRef.current) {
        return null;
      }
      const controller = new TerminalController({
        runId: runIdRef.current,
        room: tokenToSlug(token!),
        timestamp: runTimestampRef.current,
        selfSlot: selfRef.current.slot,
        selfPeerId: selfRef.current.peerId,
        send: sendControlRaw,
        freezeStages: () => stageOrchestratorRef.current?.freeze() ?? [],
        getConnectionType: () => connectionTypeRef.current,
        getPeers: (): [TerminalPeerInfo, TerminalPeerInfo] => [
          { slot: selfRef.current!.slot, peerId: selfRef.current!.peerId, profile: selfProfileRef.current },
          {
            slot: otherSlotRef.current!,
            peerId: otherPeerIdRef.current ?? "00000000-0000-5000-8000-000000000000",
            profile: otherProfileRef.current,
          },
        ],
      });
      terminalControllerRef.current = controller;
      return controller;
    }

    // The one entry point into 4.4's terminal FSM — every trigger source
    // below (clean stage completion, a stage timeout, a local cancel, a
    // remote abort, a remote run-ended, or a transport failure once
    // measurement has begun) calls this. `TerminalController.trigger` is
    // itself idempotent, so calling this repeatedly is always safe; only
    // the first call owns rendering the result and the send-run-finished/
    // teardown-grace tail.
    function finalize(trigger: FinalizeTrigger) {
      const controller = ensureTerminalController();
      if (!controller) {
        abortPreMeasurement("finalization-setup-failed");
        return;
      }
      if (finalizationStartedRef.current) {
        void controller.trigger(trigger);
        return;
      }
      finalizationStartedRef.current = true;
      updatePhase("finalizing");
      void controller.trigger(trigger).then((outcome) => {
        setTerminalResult(outcome);
        updatePhase("result");
        sendEnvelope({ type: "run-finished", runId: runIdRef.current!, payload: {} });
        lifecycleGraceTimerRef.current = setTimeout(() => {
          teardownAllConnections();
        }, LIFECYCLE_GRACE_MS);
      });
    }

    function cancelTest() {
      finalize({ kind: "local-abort", status: "CANCELED", reason: "user-canceled" });
    }
    cancelTestRef.current = cancelTest;

    function maybeStartStages() {
      if (stageOrchestratorRef.current) return;
      const bulkChannels = bulkChannelsRef.current;
      if (
        bulkChannels.some((c) => c === null) ||
        !testConfigRef.current ||
        !latencyReadyRef.current ||
        !selfRef.current ||
        !runIdRef.current
      ) {
        return;
      }
      const orchestrator = new StageOrchestrator({
        runId: runIdRef.current,
        selfSlot: selfRef.current.slot,
        testConfig: testConfigRef.current,
        send: sendControlRaw,
        bulkChannels: bulkChannels as RTCDataChannel[],
        callbacks: {
          onStageStarted: (stage) => setCurrentStage(stage),
          onProgress: (snapshot) =>
            setStageProgress((prev) => ({ ...prev, [edgeKey(snapshot.stageId, snapshot.receiverSlot)]: snapshot })),
          onStagesDone: () => finalize({ kind: "clean" }),
          onTimeout: () => finalize({ kind: "local-abort", status: "FAILED", reason: "stage-timeout" }),
        },
      });
      stageOrchestratorRef.current = orchestrator;
      orchestrator.start();
    }

    function maybeProfileExchangeComplete() {
      if (!(initialSentRef.current && initialReceivedRef.current)) return;
      if (profileTimeoutRef.current) {
        clearTimeout(profileTimeoutRef.current);
        profileTimeoutRef.current = null;
      }
      // The other half of the testing-barrier gate (03-latency §"Starting"):
      // this side may send `channel-ready` once its own initial profile is
      // sent and the peer's has validated. Sampling itself waits on the
      // peer's `channel-ready` in return.
      latencySessionRef.current?.sendChannelReady();
    }

    // getStats()-backed and must never take the initial profile send down
    // with it: a browser-specific getStats() hiccup (observed on some
    // mobile Safari versions) must not silently strand the run in
    // `pairing` for the full profile-timeout window.
    async function safeGetOwnAddress() {
      try {
        return (await controlConnRef.current?.getOwnAddress()) ?? {};
      } catch (err) {
        console.warn("getOwnAddress failed; continuing without it", err);
        return {};
      }
    }

    // Each bulk connection's own callback closure already knows its slot
    // (captured at construction time below), so opening no longer needs to
    // recover an index from the channel label the way single-connection,
    // multi-channel-per-connection did.
    function handleBulkChannelOpen(bulkSlot: number, channel: RTCDataChannel) {
      bulkChannelsRef.current[bulkSlot] = channel;
      maybeStartStages();
    }

    async function handleChannelOpen(label: ChannelLabel, channel: RTCDataChannel) {
      if (label !== "control" || !selfRef.current || !runIdRef.current) return;
      const runId = runIdRef.current;
      controlChannelRef.current = channel;

      // Created synchronously, before any `await` below, so it always
      // exists by the time `maybeProfileExchangeComplete` might call
      // `sendChannelReady` on it — that can happen either later in this
      // same function or from `handleChannelMessage` once the peer's
      // initial profile validates, and both run after this handler starts.
      if (!latencySessionRef.current) {
        latencySessionRef.current = new LatencySession({
          runId,
          send: (raw) => channel.send(raw),
          callbacks: {
            onSamplingStarted: () => updatePhase("testing"),
            onLive: setLiveLatency,
            onHandoff: (handoff) => {
              latencyHandoffFiredRef.current = true;
              if (handoff.kind === "ready") {
                setLatencyBaseline(handoff.baseline);
                // S5 gate: ICE connected + latency-ready exchanged on both
                // sides + this peer's own outcome known — throughput may
                // now proceed regardless of whether `baseline` is null
                // (04-throughput §"Gate on Phase 3").
                latencyReadyRef.current = true;
                maybeStartStages();
                return;
              }
              // "control-closed" and "run-ended" are always paired with an
              // external event that already calls `enterTerminal` itself
              // (see the `run-ended` and `handleChannelClose` handlers
              // below) — calling it again here would be a harmless no-op
              // at best, but would win the race with a more specific
              // reason at worst. Only the peer-ready timeout has no other
              // trigger site.
              if (handoff.reason === "latency-ready-timeout") {
                enterTerminal("latency-ready-timeout");
              }
            },
          },
        });
      }

      const address = await safeGetOwnAddress();
      if (terminalRef.current || runIdRef.current !== runId) return;

      const initial = buildInitialProfileMessage(
        profile,
        USER_AGENT,
        address,
        selfRef.current.slot,
      );
      selfProfileRef.current = initial;
      if (initial.timestamp) runTimestampRef.current = initial.timestamp; // slot 0 only (S6)
      try {
        channel.send(encodeProfileEnvelope(runId, initial));
      } catch (err) {
        console.warn("failed to send initial profile", err);
        return;
      }
      initialSentRef.current = true;
      maybeProfileExchangeComplete();

      // Geo enrichment: fire-and-forget, never blocks or re-gates pairing,
      // and a failure anywhere in this tail must never be mistaken for the
      // initial send above already having failed.
      try {
        const geo = await fetchGeo();
        if (terminalRef.current || runIdRef.current !== runId) return;
        const freshAddress = await safeGetOwnAddress();
        if (terminalRef.current || runIdRef.current !== runId) return;
        const enrichment = buildEnrichmentProfileMessage(
          profile,
          USER_AGENT,
          freshAddress,
          geo,
        );
        selfProfileRef.current = enrichment;
        channel.send(encodeProfileEnvelope(runId, enrichment));
      } catch (err) {
        console.warn("profile enrichment failed", err);
      }
    }

    function handleChannelMessage(label: ChannelLabel, event: MessageEvent) {
      if (label === "bulk") {
        const frame = parseBulkFrame(event.data as ArrayBuffer);
        if (frame) stageOrchestratorRef.current?.handleBulkFrame(frame);
        return;
      }
      if (label !== "control" || !runIdRef.current || otherSlotRef.current === null) return;
      const runId = runIdRef.current;

      const latencyMsg = decodeLatencyMessage(event.data, runId);
      if (latencyMsg) {
        // Ping/pong keep running for the whole testing phase (4.2): once
        // Phase 3's own handoff fires, its loop has stopped, so later
        // ping/pong belong to the stage orchestrator's continuous loop.
        if ((latencyMsg.type === "ping" || latencyMsg.type === "pong") && latencyHandoffFiredRef.current) {
          if (latencyMsg.type === "ping") stageOrchestratorRef.current?.handlePing(latencyMsg.seq);
          else stageOrchestratorRef.current?.handlePong(latencyMsg.seq);
        } else {
          latencySessionRef.current?.handleMessage(latencyMsg);
        }
        return;
      }

      const stageMsg = decodeStageMessage(event.data, runId);
      if (stageMsg) {
        if (stageMsg.type === "test-abort") {
          finalize({ kind: "remote-abort", status: stageMsg.payload.status, reason: stageMsg.payload.reason });
        } else if (stageMsg.type === "result-share") {
          ensureTerminalController()?.handleResultShare(stageMsg.payload as ResultSharePayload);
        } else {
          stageOrchestratorRef.current?.handleMessage(stageMsg);
        }
        return;
      }

      const payload = decodeProfileEnvelope(event.data, runId);
      if (payload === null) return;

      if (!initialReceivedRef.current) {
        const validated = validateInitialProfile(payload, otherSlotRef.current);
        if (!validated) return; // invalid initial profile — times out in pairing, doesn't crash
        initialReceivedRef.current = true;
        if (validated.timestamp) runTimestampRef.current = validated.timestamp; // slot 0's profile only
        setOtherProfile(validated);
        otherProfileRef.current = validated;
        maybeProfileExchangeComplete();
        return;
      }

      const enrichment = sanitizeIncomingProfile(payload);
      if (!enrichment) return;
      setOtherProfile((prev) => {
        const next = prev ? { ...prev, ...enrichment } : enrichment;
        otherProfileRef.current = next;
        return next;
      });
    }

    function handleChannelClose(label: ChannelLabel) {
      if (label === "bulk") return;
      if (label !== "control") return;
      // Post-start (03-latency §3.2): freeze whatever samples already
      // arrived before the abort path tears anything down.
      if (phaseRef.current === "testing") {
        latencySessionRef.current?.freezeForTerminal("control-closed");
      }
      if (measurementStarted()) {
        finalize({ kind: "local-abort", status: "FAILED", reason: "channel-closed" });
      } else {
        abortPreMeasurement("channel-closed");
      }
    }

    // StrictMode double-invokes effects in development: setup, cleanup,
    // then setup again, synchronously. Deferring the actual connection to
    // a macrotask means that synthetic first cleanup runs before it ever
    // opens, so only the real mount ever performs a socket connect —
    // avoiding a wasted signaling round-trip on every dev page load.
    let ws: WebSocket | null = null;
    const timer = setTimeout(() => {
      const slug = tokenToSlug(token);
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const session = getTabSessionId(slug);
      ws = new WebSocket(
        `${proto}//${window.location.host}/api/room/${slug}?session=${session}`,
      );
      wsRef.current = ws;

      ws.addEventListener("close", (event) => {
        if (terminalRef.current || event.code !== EXPIRED_CLOSE_CODE) return;
        // Hard expiry always wins (S2) and can land after measurement has
        // begun — the abort table's "Room hard expiry" row — so it must
        // join the terminal finalizer rather than the generic pre-
        // measurement screen once a record is in play.
        if (measurementStarted()) {
          finalize({ kind: "local-abort", status: "FAILED", reason: "expired" });
        } else {
          enterTerminal("expired");
        }
      });

      ws.addEventListener("message", (event) => {
        const envelope: Envelope = JSON.parse(event.data as string);
        switch (envelope.type) {
          case "peer-assigned":
            selfRef.current = envelope.payload;
            setSelf(envelope.payload);
            break;
          case "peer-joined":
            setOther(envelope.payload);
            otherSlotRef.current = envelope.payload.slot;
            otherPeerIdRef.current = envelope.payload.peerId;
            break;
          case "run-started": {
            runIdRef.current = envelope.runId;
            updatePhase("pairing");
            const otherPeer = envelope.payload.peers.find(
              (p) => p.slot !== selfRef.current?.slot,
            );
            if (otherPeer) {
              setOther(otherPeer);
              otherSlotRef.current = otherPeer.slot;
              otherPeerIdRef.current = otherPeer.peerId;
            }
            profileTimeoutRef.current = setTimeout(() => {
              if (!(initialSentRef.current && initialReceivedRef.current)) {
                abortPreMeasurement("profile-timeout");
              }
            }, PROFILE_TIMEOUT_MS);
            break;
          }
          case "test-config":
            // Snapshotted once at room claim and replayed on every accept
            // (Phase 1), so this always arrives — no client-side fallback
            // constant is ever substituted (S10, 4.1 "Done when").
            testConfigRef.current = envelope.payload;
            maybeStartStages();
            break;
          case "ice-servers": {
            if (!selfRef.current || !runIdRef.current || controlConnRef.current) break;
            const slot = selfRef.current.slot;
            const runId = runIdRef.current;
            const iceServers = envelope.payload.iceServers;
            const forceRelay = isForceRelayRequested();

            controlConnRef.current = new WebrtcConnection({
              slot,
              runId,
              connIndex: CONTROL_CONN_INDEX,
              role: "control",
              iceServers,
              forceRelay,
              send: sendEnvelope,
              callbacks: {
                onConnectionStateChange: (state) => {
                  if (state === "connected") updatePhase("paired");
                },
                onConnectionTypeChange: recomputeConnectionType,
                onFailure: handleConnectionFailure,
                onChannelOpen: (label, channel) => void handleChannelOpen(label, channel),
                onChannelMessage: handleChannelMessage,
                onChannelClose: handleChannelClose,
              },
            });

            // Genuine parallelism (04-throughput revision): each bulk
            // channel gets its own RTCPeerConnection — its own ICE
            // negotiation, DTLS session, and SCTP association/congestion
            // window — rather than sharing the control connection's one.
            for (let bulkSlot = 0; bulkSlot < BULK_CONNECTION_COUNT; bulkSlot++) {
              bulkConnsRef.current[bulkSlot] = new WebrtcConnection({
                slot,
                runId,
                connIndex: bulkConnIndex(bulkSlot),
                role: "bulk",
                iceServers,
                forceRelay,
                send: sendEnvelope,
                callbacks: {
                  onConnectionTypeChange: recomputeConnectionType,
                  onFailure: handleConnectionFailure,
                  onChannelOpen: (_label, channel) => handleBulkChannelOpen(bulkSlot, channel),
                  onChannelMessage: handleChannelMessage,
                  onChannelClose: handleChannelClose,
                },
              });
            }
            break;
          }
          case "run-ended": {
            // Post-start (03-latency §3.2): freeze whatever samples already
            // arrived before tearing anything down, so a `FAILED`
            // partial-record attempt has real data to work with even
            // though no throughput edge exists yet (Phase 4). Before the
            // testing barrier resolves this is a no-op — no result
            // boundary was crossed, and Phase 2's pre-measurement path
            // writes nothing regardless.
            if (phaseRef.current === "testing") {
              latencySessionRef.current?.freezeForTerminal("run-ended");
            }
            if (measurementStarted()) {
              // Joins the same terminal controller (4.4 step 6): records
              // the reason and tears down without the generic pre-
              // measurement terminal screen, which the assembled result
              // page now supersedes.
              finalize({ kind: "remote-run-ended", reason: envelope.payload.reason });
              if (lifecycleGraceTimerRef.current) {
                clearTimeout(lifecycleGraceTimerRef.current);
                lifecycleGraceTimerRef.current = null;
              }
              teardownAllConnections();
            } else {
              teardownAllConnections();
              enterTerminal(envelope.payload.reason);
            }
            break;
          }
          case "ping":
            sendEnvelope({ type: "pong", runId: envelope.runId, payload: {} });
            break;
          case "offer":
          case "answer":
          case "ice-candidate":
            connectionForIndex(envelope.connIndex)?.handleSignalingMessage(envelope);
            break;
          default:
            break;
        }
      });
    }, 0);

    return () => {
      clearTimeout(timer);
      if (profileTimeoutRef.current) clearTimeout(profileTimeoutRef.current);
      if (lifecycleGraceTimerRef.current) clearTimeout(lifecycleGraceTimerRef.current);
      latencySessionRef.current?.reset();
      stageOrchestratorRef.current?.stop();
      teardownAllConnections();
      ws?.close();
    };
  }, [token, confirmedProfile]);

  if (token === null) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4">
        <p className="text-sm text-red-600 dark:text-red-400">
          "{params.slug}" isn't a valid Room ID.
        </p>
      </main>
    );
  }

  const slug = tokenToSlug(token);
  const emojiKey = tokenToEmojiKey(token);
  const link =
    typeof window !== "undefined"
      ? `${window.location.origin}/room/${slug}`
      : `/room/${slug}`;

  const roomSummary = (
    <section className="flex w-full max-w-sm flex-col gap-3 rounded-2xl border border-gray-200 p-5 text-center dark:border-gray-700">
      <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
        Room ID
      </p>
      <div className="flex items-center justify-center gap-2">
        <p className="font-mono text-lg text-gray-900 dark:text-gray-100">
          <span className="after:content-['-'] after:px-1 after:text-gray-700 dark:after:text-gray-400">{slug.split("").slice(0, 3).join("")}</span>
          <span className="after:content-['-'] after:px-1 after:text-gray-700 dark:after:text-gray-400">{slug.split("").slice(3, 6).join("")}</span>
          <span>{slug.split("").slice(6, 9).join("")}</span>
        </p>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(slug).catch((error: unknown) => {
              console.warn("Failed to copy Room ID", error);
            });
          }}
          aria-label="Copy Room ID"
          title="Copy Room ID"
          className="w-6 rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100 mr-[-1.5rem] cursor-pointer"
        >
          <BsCopy aria-hidden="true" className="size-4" />
        </button>
      </div>
      <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
        Emoji key
      </p>
      <p className="text-2xl">{emojiKey}</p>
      <p className="break-all text-xs text-gray-500 dark:text-gray-400">{link}</p>
    </section>
  );

  if (confirmedProfile === null) {
    return (
      <main className="flex min-h-screen flex-col items-center gap-8 px-4 py-16">
        {roomSummary}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!gateProfile) return;
            const trimmed = gateProfile.name.trim();
            if (!trimmed) return;
            const confirmed: ConfirmedProfile = { ...gateProfile, name: trimmed };
            saveProfile(confirmed);
            setConfirmedProfile(confirmed);
          }}
          className="flex w-full max-w-sm flex-col gap-4 rounded-2xl border border-gray-200 p-5 dark:border-gray-700"
        >
          <h2 className="text-sm font-medium text-gray-700 dark:text-gray-200">
            Confirm your profile before joining
          </h2>
          {gateProfile && (
            <ProfileFields profile={gateProfile} onChange={setGateProfile} userAgent={USER_AGENT} />
          )}
          <button
            type="submit"
            disabled={!gateProfile}
            className="rounded-full bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900"
          >
            Join room
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center gap-8 px-4 py-16">
      {roomSummary}

      <section className="flex w-full max-w-sm flex-col items-center gap-4 rounded-2xl border border-gray-200 p-5 dark:border-gray-700">
        {terminal ? (
          <>
            <p
              className={
                terminalTone(terminal.reason) === "error"
                  ? "text-red-600 dark:text-red-400"
                  : "text-gray-700 dark:text-gray-200"
              }
            >
              {terminalMessage(terminal.reason)}
            </p>
            <a
              href="/"
              className="rounded-full border border-gray-300 px-4 py-2 text-sm font-medium text-gray-900 dark:border-gray-600 dark:text-gray-100"
            >
              Start a new room
            </a>
          </>
        ) : phase === "result" && terminalResult ? (
          <ResultSummary
            outcome={terminalResult}
            onNewRoom={() => {
              window.location.href = "/";
            }}
          />
        ) : (
          <>
            {connectionType !== "UNKNOWN" ||
            phase === "paired" ||
            phase === "testing" ||
            phase === "finalizing" ? (
              <ConnectionBadge type={connectionType} />
            ) : null}
            <p className="text-gray-700 dark:text-gray-200">
              {phase === "waiting" && (other ? "Peer joined!" : "Waiting for a peer…")}
              {phase === "pairing" && "Connecting to peer…"}
              {phase === "paired" && "Paired!"}
              {phase === "testing" &&
                (currentStage === null
                  ? "Measuring latency…"
                  : `Measuring ${stageName(currentStage)}…`)}
              {phase === "finalizing" && "Finalizing…"}
            </p>
            {self && (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                You are slot {self.slot}
                {other ? `, peer is slot ${other.slot}` : ""}
              </p>
            )}
            {otherProfile ? (
              <OtherPeerSummary profile={otherProfile} />
            ) : (
              phase !== "waiting" && (
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Waiting for the other peer to introduce themselves…
                </p>
              )
            )}
            {phase === "testing" && (
              <div className="flex flex-col items-center gap-1">
                {latencyBaseline === undefined ? (
                  liveLatency ? (
                    <p className="text-sm text-gray-700 dark:text-gray-200">
                      RTT {liveLatency.rttMs.toFixed(0)} ms
                      {liveLatency.jitterMs !== null &&
                        ` · jitter ${liveLatency.jitterMs.toFixed(1)} ms`}
                    </p>
                  ) : (
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      Measuring…
                    </p>
                  )
                ) : latencyBaseline === null ? (
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    Couldn't measure latency.
                  </p>
                ) : (
                  <p className="text-sm text-gray-700 dark:text-gray-200">
                    RTT {latencyBaseline.rttMs.toFixed(0)} ms · jitter{" "}
                    {latencyBaseline.jitterMs.toFixed(1)} ms
                  </p>
                )}
              </div>
            )}
            {phase === "testing" && currentStage !== null && self && (
              <div className="flex flex-col items-center gap-1">
                {Object.entries(stageProgress)
                  .filter(([key]) => key.startsWith(`${currentStage}:`))
                  .map(([key, snap]) => (
                    <p key={key} className="text-sm text-gray-700 dark:text-gray-200">
                      {snap.receiverSlot === self.slot ? "You" : "Peer"} receiving:{" "}
                      {formatMbps(snap.bytes, snap.elapsedMs)} Mbps
                      {snap.highestSeqPlusOne > 0 &&
                        ` · loss ${(
                          (1 - snap.chunksSeen / snap.highestSeqPlusOne) *
                          100
                        ).toFixed(1)}%`}
                    </p>
                  ))}
              </div>
            )}
            {(phase === "testing" || phase === "finalizing") && (
              <button
                type="button"
                disabled={phase === "finalizing"}
                onClick={() => cancelTestRef.current()}
                className="rounded-full border border-gray-300 px-4 py-2 text-sm font-medium text-gray-900 disabled:opacity-50 dark:border-gray-600 dark:text-gray-100"
              >
                Cancel
              </button>
            )}
          </>
        )}
      </section>
    </main>
  );
}
