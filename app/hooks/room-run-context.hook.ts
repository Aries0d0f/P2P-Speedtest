import { useCallback, useMemo, useRef, useState, type RefObject } from "react";

import type { ConnectionType } from "~/model/connection.model";
import type { LatencyAggregate, LiveLatency, StageProgress } from "~/model/measurement.model";
import type { PeerIdentity, ConfirmedProfile, PeerProfile } from "~/model/peer.model";
import type { TestConfigPayload } from "~/model/signaling.model";
import type { StageId } from "~/model/stage.model";
import type {
  RoomPhase,
  RoomRunContext,
  RoomState,
  TerminalOutcome,
  TerminalReason,
} from "~/model/room.model";

/**
 * The run's shared mutable state, plus the React mirror of it.
 *
 * Every sub-hook's callbacks are created once and then live for the whole run,
 * so they cannot read React state — it would be stale by the time a socket or
 * data-channel event fires. They read `ctx.current` instead, and the setters
 * below write the ref and the mirror together so the two can never disagree.
 */
export interface RoomRunContextHandle {
  ctx: RefObject<RoomRunContext>;
  state: RoomState;
  setPhase: (next: RoomPhase) => void;
  setRunId: (runId: string) => void;
  setSelf: (self: PeerIdentity, expiresAt: string) => void;
  setOther: (other: PeerIdentity) => void;
  setSelfProfile: (profile: PeerProfile) => void;
  /** `update` receives the previous profile so an enrichment can merge onto it. */
  setOtherProfile: (update: (prev: PeerProfile | null) => PeerProfile) => void;
  /** Display-only: never overwrites a profile a real `peer-profile` authored. */
  setProvisionalSelfProfile: (profile: PeerProfile) => void;
  setConnectionType: (type: ConnectionType) => void;
  setTestConfig: (config: TestConfigPayload) => void;
  setRunTimestamp: (timestamp: string) => void;
  setStageId: (stageId: StageId) => void;
  recordProgress: (snapshot: StageProgress) => void;
  setLiveLatency: (latency: LiveLatency) => void;
  setLatencyBaseline: (baseline: LatencyAggregate | null) => void;
  setTerminal: (reason: TerminalReason) => void;
  setOutcome: (outcome: TerminalOutcome) => void;
}

export function useRoomRunContext(
  token: number | null,
  slug: string,
  profile: ConfirmedProfile | null,
): RoomRunContextHandle {
  const ctx = useRef<RoomRunContext>({
    token: token ?? -1,
    slug,
    profile: profile ?? { name: "", privacyLevel: "off" },
    runId: null,
    self: null,
    other: null,
    runTimestamp: null,
    selfProfile: null,
    otherProfile: null,
    connectionType: "UNKNOWN",
    phase: "waiting",
    terminal: false,
    testConfig: null,
  });
  ctx.current.token = token ?? -1;
  ctx.current.slug = slug;
  if (profile) ctx.current.profile = profile;

  const [phase, setPhaseState] = useState<RoomPhase>("waiting");
  const [runId, setRunIdState] = useState<string | null>(null);
  const [self, setSelfState] = useState<(PeerIdentity & { expiresAt: string }) | null>(null);
  const [other, setOtherState] = useState<PeerIdentity | null>(null);
  const [selfProfile, setSelfProfileState] = useState<PeerProfile | null>(null);
  const [otherProfile, setOtherProfileState] = useState<PeerProfile | null>(null);
  const [connectionType, setConnectionTypeState] = useState<ConnectionType>("UNKNOWN");
  const [liveLatency, setLiveLatencyState] = useState<LiveLatency | null>(null);
  // `undefined`: the latency sub-phase hasn't finalized; `null`: it finalized
  // without a usable aggregate (< 3 samples).
  const [latencyBaseline, setLatencyBaselineState] =
    useState<LatencyAggregate | null | undefined>(undefined);
  const [stageId, setStageIdState] = useState<StageId | null>(null);
  const [stageProgress, setStageProgressState] = useState<RoomState["stageProgress"]>({
    runId: null,
    entries: {},
  });
  const [terminal, setTerminalState] = useState<{ reason: TerminalReason } | null>(null);
  const [outcome, setOutcomeState] = useState<TerminalOutcome | null>(null);

  const setPhase = useCallback((next: RoomPhase) => {
    ctx.current.phase = next;
    setPhaseState(next);
  }, []);

  const setRunId = useCallback((next: string) => {
    ctx.current.runId = next;
    setRunIdState(next);
  }, []);

  const setSelf = useCallback((next: PeerIdentity, expiresAt: string) => {
    ctx.current.self = next;
    setSelfState({ ...next, expiresAt });
  }, []);

  const setOther = useCallback((next: PeerIdentity) => {
    ctx.current.other = next;
    setOtherState(next);
  }, []);

  const setSelfProfile = useCallback((next: PeerProfile) => {
    ctx.current.selfProfile = next;
    setSelfProfileState(next);
  }, []);

  const setProvisionalSelfProfile = useCallback((next: PeerProfile) => {
    // `prev ?? …` means a real `peer-profile` message always wins, whatever
    // order the two resolve in. `ctx.selfProfile` — which authors this peer's
    // entry in the stored record — is deliberately not written here.
    setSelfProfileState((prev) => prev ?? next);
  }, []);

  const setOtherProfile = useCallback((update: (prev: PeerProfile | null) => PeerProfile) => {
    setOtherProfileState((prev) => {
      const next = update(prev);
      ctx.current.otherProfile = next;
      return next;
    });
  }, []);

  const setConnectionType = useCallback((next: ConnectionType) => {
    ctx.current.connectionType = next;
    setConnectionTypeState(next);
  }, []);

  const setTestConfig = useCallback((next: TestConfigPayload) => {
    ctx.current.testConfig = next;
  }, []);

  const setRunTimestamp = useCallback((next: string) => {
    ctx.current.runTimestamp = next;
  }, []);

  const setStageId = useCallback((next: StageId) => setStageIdState(next), []);

  const recordProgress = useCallback((snapshot: StageProgress) => {
    setStageProgressState((prev) => {
      const currentRun = ctx.current.runId;
      // A bank from a previous run is dropped, never merged.
      const entries = prev.runId === currentRun ? prev.entries : {};
      return {
        runId: currentRun,
        entries: {
          ...entries,
          [`${snapshot.stageId}:${snapshot.receiverSlot}`]: snapshot,
        },
      };
    });
  }, []);

  const setLiveLatency = useCallback((next: LiveLatency) => setLiveLatencyState(next), []);
  const setLatencyBaseline = useCallback(
    (next: LatencyAggregate | null) => setLatencyBaselineState(next),
    [],
  );

  const setTerminal = useCallback((reason: TerminalReason) => {
    setTerminalState({ reason });
  }, []);

  const setOutcome = useCallback((next: TerminalOutcome) => setOutcomeState(next), []);

  const state = useMemo<RoomState>(
    () => ({
      phase,
      runId,
      self,
      other,
      selfProfile,
      otherProfile,
      connectionType,
      liveLatency,
      latencyBaseline,
      stageId,
      stageProgress,
      terminal,
      outcome,
    }),
    [
      phase,
      runId,
      self,
      other,
      selfProfile,
      otherProfile,
      connectionType,
      liveLatency,
      latencyBaseline,
      stageId,
      stageProgress,
      terminal,
      outcome,
    ],
  );

  return {
    ctx,
    state,
    setPhase,
    setRunId,
    setSelf,
    setOther,
    setSelfProfile,
    setOtherProfile,
    setProvisionalSelfProfile,
    setConnectionType,
    setTestConfig,
    setRunTimestamp,
    setStageId,
    recordProgress,
    setLiveLatency,
    setLatencyBaseline,
    setTerminal,
    setOutcome,
  };
}
