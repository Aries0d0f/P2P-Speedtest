import { useEffect, useRef, useState } from "react";
import { BsCopy } from "react-icons/bs";
import { useLocation } from "react-router";
import { ConnectionBadge } from "~/components/ConnectionBadge";
import { ProfileFields } from "~/components/ProfileFields";
import type { GeoInfo } from "~/lib/geo";
import { fetchGeo } from "~/lib/geo";
import {
  decodeLatencyMessage,
  LatencySession,
  type Aggregate,
  type LiveLatency,
} from "~/lib/latency";
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
  type ReceivedPeerProfile,
} from "~/lib/peer-profile";
import { EXPIRED_CLOSE_CODE, type Envelope, type Slot } from "~/lib/protocol";
import { slugToToken, tokenToEmojiKey, tokenToSlug } from "~/lib/room-token";
import type { ChannelLabel, ConnectionType } from "~/lib/webrtc";
import { WebrtcConnection, isForceRelayRequested } from "~/lib/webrtc";

import type { Route } from "./+types/room";

export function meta({}: Route.MetaArgs) {
  return [{ title: "P2P Speedtest — Room" }];
}

interface PeerInfo {
  slot: Slot;
  peerId: string;
}

type Phase = "waiting" | "pairing" | "paired" | "testing";

interface TerminalState {
  reason: string;
}

const USER_AGENT = typeof navigator !== "undefined" ? navigator.userAgent : "";

// A missing/invalid initial profile must not strand the room forever —
// this bounds how long `pairing` waits before treating it as a failure
// (2.6's testing-barrier prerequisite).
const PROFILE_TIMEOUT_MS = 20_000;

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

  const wsRef = useRef<WebSocket | null>(null);
  const webrtcRef = useRef<WebrtcConnection | null>(null);
  const latencySessionRef = useRef<LatencySession | null>(null);
  const runIdRef = useRef<string | null>(null);
  const selfRef = useRef<PeerInfo | null>(null);
  const otherSlotRef = useRef<Slot | null>(null);
  const phaseRef = useRef<Phase>("waiting");
  const terminalRef = useRef(false);
  const initialSentRef = useRef(false);
  const initialReceivedRef = useRef(false);
  const profileTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      webrtcRef.current?.teardown();
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
        return (await webrtcRef.current?.getOwnAddress()) ?? {};
      } catch (err) {
        console.warn("getOwnAddress failed; continuing without it", err);
        return {};
      }
    }

    async function handleChannelOpen(label: ChannelLabel, channel: RTCDataChannel) {
      if (label !== "control" || !selfRef.current || !runIdRef.current) return;
      const runId = runIdRef.current;

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
              if (handoff.kind === "ready") {
                setLatencyBaseline(handoff.baseline);
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
        channel.send(encodeProfileEnvelope(runId, enrichment));
      } catch (err) {
        console.warn("profile enrichment failed", err);
      }
    }

    function handleChannelMessage(label: ChannelLabel, event: MessageEvent) {
      if (label !== "control" || !runIdRef.current || otherSlotRef.current === null) return;
      const runId = runIdRef.current;

      const latencyMsg = decodeLatencyMessage(event.data, runId);
      if (latencyMsg) {
        latencySessionRef.current?.handleMessage(latencyMsg);
        return;
      }

      const payload = decodeProfileEnvelope(event.data, runId);
      if (payload === null) return;

      if (!initialReceivedRef.current) {
        const validated = validateInitialProfile(payload, otherSlotRef.current);
        if (!validated) return; // invalid initial profile — times out in pairing, doesn't crash
        initialReceivedRef.current = true;
        setOtherProfile(validated);
        maybeProfileExchangeComplete();
        return;
      }

      const enrichment = sanitizeIncomingProfile(payload);
      if (!enrichment) return;
      setOtherProfile((prev) => (prev ? { ...prev, ...enrichment } : enrichment));
    }

    function handleChannelClose(label: ChannelLabel) {
      if (label !== "control") return;
      // Post-start (03-latency §3.2): freeze whatever samples already
      // arrived before `abortPreMeasurement` tears anything down. Its own
      // `enterTerminal("channel-closed")` still wins the visible reason —
      // see the `onHandoff` comment above.
      if (phaseRef.current === "testing") {
        latencySessionRef.current?.freezeForTerminal("control-closed");
      }
      abortPreMeasurement("channel-closed");
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
        if (!terminalRef.current && event.code === EXPIRED_CLOSE_CODE) {
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
            }
            profileTimeoutRef.current = setTimeout(() => {
              if (!(initialSentRef.current && initialReceivedRef.current)) {
                abortPreMeasurement("profile-timeout");
              }
            }, PROFILE_TIMEOUT_MS);
            break;
          }
          case "ice-servers": {
            if (!selfRef.current || !runIdRef.current || webrtcRef.current) break;
            webrtcRef.current = new WebrtcConnection({
              slot: selfRef.current.slot,
              runId: runIdRef.current,
              iceServers: envelope.payload.iceServers,
              forceRelay: isForceRelayRequested(),
              send: sendEnvelope,
              callbacks: {
                onConnectionStateChange: (state) => {
                  if (state === "connected") updatePhase("paired");
                },
                onConnectionTypeChange: setConnectionType,
                onFailure: abortPreMeasurement,
                onChannelOpen: (label, channel) => void handleChannelOpen(label, channel),
                onChannelMessage: handleChannelMessage,
                onChannelClose: handleChannelClose,
              },
            });
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
            webrtcRef.current?.teardown();
            enterTerminal(envelope.payload.reason);
            break;
          }
          case "ping":
            sendEnvelope({ type: "pong", runId: envelope.runId, payload: {} });
            break;
          case "offer":
          case "answer":
          case "ice-candidate":
            webrtcRef.current?.handleSignalingMessage(envelope);
            break;
          default:
            break;
        }
      });
    }, 0);

    return () => {
      clearTimeout(timer);
      if (profileTimeoutRef.current) clearTimeout(profileTimeoutRef.current);
      latencySessionRef.current?.reset();
      webrtcRef.current?.teardown();
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
        ) : (
          <>
            {connectionType !== "UNKNOWN" || phase === "paired" || phase === "testing" ? (
              <ConnectionBadge type={connectionType} />
            ) : null}
            <p className="text-gray-700 dark:text-gray-200">
              {phase === "waiting" && (other ? "Peer joined!" : "Waiting for a peer…")}
              {phase === "pairing" && "Connecting to peer…"}
              {phase === "paired" && "Paired!"}
              {phase === "testing" && "Measuring latency…"}
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
          </>
        )}
      </section>
    </main>
  );
}
