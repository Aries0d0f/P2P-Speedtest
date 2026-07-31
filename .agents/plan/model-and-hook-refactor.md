# Implementation Plan: Model & Hook Architecture Refactor

> **Status**: DRAFT
> **Created**: 2026-07-31

## Overview

The app works, but its structure has decayed. Type declarations are scattered
through the modules that happen to use them first, so one domain concept is
described by six or seven near-identical interfaces (`PeerProfileMessage`,
`ReceivedPeerProfile`, `ValidatedInitialProfile`, `ResultPeer`,
`AssemblePeerInfo`, `TerminalPeerInfo`, `VisualPeer`, `VisualProfileInput`).
`Slot` is declared twice. `ViaType` and `ConnectionType` are the same union under
two names. `result-validate.ts` privately re-declares four types it already
imports elsewhere. On the UI side, `room.tsx` is 1259 lines with a single
580-line `useEffect` holding the WebSocket, five `RTCPeerConnection`s, the
latency session, the stage orchestrator, the terminal controller and 35 refs.

This plan restructures without changing mechanism or UI. Every wire message,
timer, gate, ordering rule and rendered pixel stays identical. What changes is
where things live and how many names each thing has.

Three rules drive it:

1. **One interface per model.** Each domain concept gets exactly one canonical
   interface in `app/model/<name>.model.ts`. Every other shape of it is a type
   utility over that interface — `Pick`, `Omit`, `Required`, `NonNullable`,
   intersection. No parallel declarations.
2. **`app/lib` becomes behaviour-only.** Modules there export functions and
   classes, not domain types.
3. **Components render; hooks live.** Lifecycle moves into
   `app/hooks/<name>.hook.ts` modules with the shape
   `const { a, b, c } = useThing(dep1, dep2, opts)`.

## Requirements

- No behavioural change: identical wire messages, message ordering, timer
  values, gates, and failure paths.
- No UI change: identical DOM, class names, copy, and `data-testid`s.
- All domain types live in `app/model/<name>.model.ts`, carrying their own
  type guards, sanitizers and constants alongside the interface they describe.
- One canonical interface per model; variants expressed with type utilities.
- Hooks live in `app/hooks/<name>.hook.ts` and destructure their return value.
- No `useEffect` in a component that does more than wire one hook to one prop.
- Comments state non-obvious invariants only (see "Comment policy" below).
- `bun run typecheck` passes.
- `bun run test` shows no new failures against the recorded baseline.

### Comment policy

The user's instruction is not to spend implementation time writing docs. Applied
literally to this codebase that would delete real knowledge: comments like "a
forged direction is never banked" or "ramp-up chunks never consume the measured
sequence space" encode protocol invariants that are not recoverable from the
code. The rule for this refactor:

- **Delete** module-level essays that restate `.claude/plan/*.md`, comments that
  narrate what the next line does, and phase-number cross-references.
- **Keep, one line** anything a reader would otherwise get wrong: why a value is
  `null` rather than `0`, why a call is deliberately not awaited, why an order
  is load-bearing.
- **Never write** a new explanatory comment during a mechanical move.

Expected outcome: roughly 1,400 comment lines drop to about 250.

## Architecture Analysis

### Current type fragmentation

| Concept | Declared as | In |
|---|---|---|
| Peer | `ConfirmedProfile`, `PeerProfileMessage`, `ReceivedPeerProfile`, `ValidatedInitialProfile` | `lib/peer-profile.ts` |
| Peer | `ResultPeer`, `AssemblePeerInfo` | `lib/results.ts` |
| Peer | `TerminalPeerInfo` | `lib/control-channel.ts` |
| Peer | `VisualPeer`, `VisualProfileInput` | `lib/test-visualization.ts` |
| Peer | `Peer` (private) | `lib/result-validate.ts` |
| Peer | `PeerInfo` (local) | `routes/room.tsx` |
| Slot | `Slot` | `lib/protocol.ts` **and** `lib/stage.ts` |
| Connection type | `ConnectionType` / `ViaType` | `lib/webrtc.ts` / `lib/results.ts` |
| Channel label | `ChannelLabel` / `ConnectionRole` | `lib/webrtc.ts` (self-alias) |
| Room phase | `RoomPhase` / `Phase` | `lib/test-visualization.ts` / `routes/room.tsx` |
| Coordinates | `VisualLocation` / `LatLon` | `lib/test-visualization.ts` / `lib/globe-math.ts` |
| Progress snapshot | `ReceiverSnapshot` / `StageProgressSnapshot` | `lib/throughput.ts` / `lib/control-channel.ts` |
| Measurement | `Measurement` / `SealedMeasurement` | `lib/stage.ts` / `lib/throughput.ts` |
| Result record | `ResultData`, `BandwidthEdge` | `lib/results.ts` **and** privately in `lib/result-validate.ts` |

`ReceiverSnapshot` and `StageProgressSnapshot` have been verified field-identical
modulo `stageId`/`receiverSlot`; `SealedMeasurement` is verified to be exactly
`Measurement` minus `latency`/`jitter`; `VisualLocation` and `LatLon` are
identical. These are mechanical collapses, not redesigns.

### Current UI lifecycle

| File | Lines | Effects | Refs | Problem |
|---|---|---|---|---|
| `routes/room.tsx` | 1259 | 6 | 35 | One 580-line effect owns the entire room FSM |
| `components/speedtest/PeerGlobe.tsx` | 429 | 7 | 7 | Renderer lifecycle, portal, two `ResizeObserver` boxes, visibility, failure latch |
| `components/speedtest/SpeedGauge.tsx` | 227 | 2 | 3 | Anime.js scalar wiring duplicated with the graph |
| `components/speedtest/RealtimeSpeedGraph.tsx` | 276 | 3 | 2 | Same scalar wiring, plus an inline dynamic-import draw-in |
| `routes/results.tsx` | 300 | 1 | 1 | Load/export/import orchestration inline |
| `routes/results.$room.$peerId.tsx` | 223 | 1 | 0 | Load-with-cancel inline; 60-line IIFE inside JSX |

### Key dependencies

| Dependency | Used by | Impact |
|---|---|---|
| `lib/protocol.ts` | `workers/signaling-room.ts`, `room.tsx`, `webrtc.ts` | Worker imports it — the model move must keep it importable from `workers/`, which builds under `tsconfig.cloudflare.json` with the same `~/*` path alias. Verified: `workers/` already imports `~/lib/protocol` and `~/lib/room-token`. |
| `lib/generated/*` | `result-validate.ts` | Build output from `scripts/build-schema.mjs`. **Never edit.** Regenerated on `pre*` scripts. |
| `schemas/*.v1.schema.yaml` | validation, `ResultPeer` | `additionalProperties: false` on `peer`, `data`, `metadata`. `ResultPeer` must therefore be exactly the schema's field set — a `Pick` that accidentally widens breaks storage at runtime, not at compile time. Locked by a type-level assertion (Phase 1.7). |
| `vitest.config.ts` | all tests | Two projects: `app/**/*.test.ts` runs in **workerd**, `app/**/*.test.tsx` in jsdom. A `.model.ts` file that touches a DOM global at module scope breaks the workers pool. Models must be import-safe in both runtimes. |
| `verbatimModuleSyntax: true` | all | Every type-only import must use `import type`. Mechanical, but a mass import rewrite will trip it repeatedly. |

### Test baseline (recorded 2026-07-31, before any change)

```
bun run typecheck   -> pass
bun run test        -> Test Files 1 failed | 21 passed (22)
                       Tests 6 failed | 417 passed (423)
```

All 6 failures are pre-existing in `workers/signaling-room.test.ts`:
`rejects a third connection`, `relays a message between two peers verbatim`,
`rebuilds slot/peer state from getWebSockets + storage after an eviction`,
`never evicts a live, responsive peer via a third join attempt`,
`ends the room exactly once after both peers send run-finished`,
`emits finalization-timeout when only one peer finishes`.

They are out of scope. Every phase must end at exactly these 6 failures — no
more, and none in a different file.

## Target Structure

```
app/model/                     types + their guards/constants, no behaviour
  geo.model.ts
  signaling.model.ts           Slot, Envelope union, TestConfigPayload, isEnvelope
  connection.model.ts          ConnectionType, ChannelLabel, OwnAddress
  stage.model.ts               StageId, roles, edgeKey, STAGE_ORDER
  measurement.model.ts         Measurement, progress, latency, bank entries
  bulk-frame.model.ts          BulkFrame, BulkChannel, header constants
  peer.model.ts                PeerData + every projection
  result.model.ts              P2PSpeedtestResult, ResultData, BandwidthEdge
  storage.model.ts             save/list/get/export/import outcomes, ValidationResult
  control-message.model.ts     one ControlMessage union for the control channel
  presentation.model.ts        RoomPhase, TransferChannel, LiveTestPresentation
  speed-series.model.ts        Series, SpeedSeriesState
  globe.model.ts               GlobeFrame, GlobeScene, quality tiers, Vec3/Quat
  room.model.ts                RoomState, RoomRunContext, TerminalReason/Outcome

app/hooks/                     lifecycle, one concern each
  room-session.hook.ts         composite; owns RoomRunContext
  signaling-socket.hook.ts
  peer-connections.hook.ts
  peer-profile-exchange.hook.ts
  latency-session.hook.ts
  stage-orchestrator.hook.ts
  terminal-controller.hook.ts
  confirmed-profile.hook.ts
  geo-prefetch.hook.ts
  live-presentation.hook.ts
  visual-failure.hook.ts
  globe-scene.hook.ts
  portal-host.hook.ts
  element-box.hook.ts
  document-visible.hook.ts
  reduced-motion.hook.ts
  speed-series.hook.ts
  animated-scalar.hook.ts
  svg-draw-in.hook.ts
  stored-result.hook.ts
  result-history.hook.ts
  clipboard-copy.hook.ts
  room-link.hook.ts

app/lib/                       behaviour only
  geo.ts webrtc.ts latency.ts throughput.ts room-token.ts qr.ts
  result-hash.ts result-validate.ts results-store.ts globe-math.ts
  peer-profile.ts              builders/sanitizers only
  control-message.ts           one decoder for the whole control vocabulary
  stage-orchestrator.ts        split out of control-channel.ts
  terminal-controller.ts       split out of control-channel.ts
  presentation-selector.ts     was test-visualization.ts
```

### The canonical `PeerData`

```ts
// app/model/peer.model.ts
export type PrivacyLevel = "off" | "on" | "anonymous";
export type IpProtocol = "IPv4" | "IPv6";

export interface PeerData {
  id: string;
  slot: Slot;
  name: string;
  privacyLevel: PrivacyLevel;
  ua?: string;
  ip?: string;
  protocol?: IpProtocol;
  geo?: GeoInfo;
  timestamp?: string;
}

export type ConfirmedProfile = Pick<PeerData, "name" | "privacyLevel">;
export type PeerIdentity     = Pick<PeerData, "id" | "slot">;
export type PeerProfile      = Omit<PeerData, "id" | "slot" | "privacyLevel">;
export type InitialProfile   = PeerProfile & Required<Pick<PeerProfile, "timestamp">>;
export type ResultPeer       = Pick<PeerData, "id" | "name" | "ua" | "ip" | "protocol" | "geo">;
export type PeerView         = Pick<PeerData, "slot" | "name"> & {
  location: GeoPoint | null;
  profileKnown: boolean;
};
```

Eight declarations become one plus six utilities. Two consequences worth calling
out before implementation:

- `privacyLevel` is absent from `PeerProfile`, which is correct and load-bearing:
  the level never leaves the browser, it is *applied* at send time by
  `buildInitialProfileMessage` / `buildEnrichmentProfileMessage`.
- Today `PeerProfileMessage.geo` is `GeoInfo | Pick<GeoInfo, "proxy" | "hosting">`.
  Since every `GeoInfo` field is optional, the anonymous projection is already a
  valid `GeoInfo`, so the union collapses to `geo?: GeoInfo`. Privacy stays
  enforced where it actually is enforced — in `projectGeoForAnonymous`, at the
  sender — rather than by a type that only documents the intent. `geo.test.ts`
  and `peer-profile.test.ts` already cover this at runtime.

### Other collapses

```ts
// app/model/measurement.model.ts
export interface Measurement {
  bytes: number; durationMs: number; latency: number; jitter: number;
  chunksSeen: number; chunksExpected: number;
}
export type SealedMeasurement = Omit<Measurement, "latency" | "jitter">;

export interface MeasurementProgress {
  elapsedMs: number; bytes: number; chunksSeen: number; highestSeqPlusOne: number;
}
export interface StageEdge { stageId: StageId; receiverSlot: Slot }
export type StageBankEntry = StageEdge & { measurement: Measurement };
export type StageProgress  = StageEdge & MeasurementProgress;

export interface Latency { rttMs: number; jitterMs: number | null }
export type LatencyAggregate = { [K in keyof Latency]: NonNullable<Latency[K]> };
export type LiveLatency = Latency & { sampleCount: number };
```

`ReceiverSnapshot` → `MeasurementProgress`. `StageProgressSnapshot` →
`StageProgress`. `Aggregate` → `LatencyAggregate`.

```ts
// app/model/room.model.ts
export interface RoomState {
  phase: RoomPhase;
  runId: string | null;
  self: (PeerIdentity & { expiresAt: string }) | null;
  other: PeerIdentity | null;
  selfProfile: PeerProfile | null;
  otherProfile: PeerProfile | null;
  connectionType: ConnectionType;
  liveLatency: LiveLatency | null;
  latencyBaseline: LatencyAggregate | null | undefined;
  stageId: StageId | null;
  stageProgress: { runId: string | null; entries: Record<string, StageProgress> };
  terminal: { reason: TerminalReason } | null;
  outcome: TerminalOutcome | null;
}
```

and then, in `presentation.model.ts`, the selector's input is derived rather
than re-declared — this is what removes `LiveTestRoomView` and
`VisualProfileInput` outright:

```ts
export type LiveTestRoomView = Pick<
  RoomState,
  | "runId" | "phase" | "stageId" | "stageProgress"
  | "liveLatency" | "latencyBaseline" | "connectionType"
  | "selfProfile" | "otherProfile"
>;
```

`TerminalReason` stops being a bare `string`:

```ts
export type LocalFailureReason =
  | "ice-failed" | "negotiation-failed" | "profile-timeout" | "channel-closed"
  | "latency-ready-timeout" | "stage-timeout" | "user-canceled"
  | "finalization-setup-failed";
export type TerminalReason = RunEndedReason | LocalFailureReason;
```

which makes `TERMINAL_COPY` exhaustively checkable instead of a `Record<string, string>`
with a `??` fallback.

### One control-message decoder

Today `room.tsx` runs three decoders in sequence — `decodeLatencyMessage`,
`decodeStageMessage`, `decodeProfileEnvelope` — each of which `JSON.parse`s the
same string again and returns `null` for types it does not own. They already
share one vocabulary (`CONTROL_MESSAGE_TYPES` in `latency.ts` lists all 14 names,
including the ones it does not handle).

Target: one `ControlMessage` discriminated union in
`app/model/control-message.model.ts` and one
`decodeControlMessage(data, runId): ControlMessage | null` in
`app/lib/control-message.ts`. Per-type accept/reject rules are moved verbatim —
this is a merge, not a rewrite. Payload shapes reference the models instead of
restating them:

```ts
| { runId: string; type: "measurement-progress"; stageId: StageId;
    receiverSlot: Slot; progressSeq: number; payload: MeasurementProgress }
| { runId: string; type: "stage-result"; stageId: StageId;
    receiverSlot: Slot; payload: { measurement: Measurement } }
| { runId: string; type: "peer-profile"; payload: PeerProfile }
| { runId: string; type: "result-share"; payload: ResultShare }
```

Routing stays in the room hooks, unchanged — including the rule that once the
latency handoff has fired, `ping`/`pong` go to the stage orchestrator's
continuous loop rather than back to the latency session.

### Composed room hooks

Per the chosen approach, refs stay in React. The 35 scattered refs become **one
typed context object** plus per-hook instance/timer refs. `RoomRunContext` is the
shared mutable run state the sub-hooks read from each other's callbacks; it is
created once by `useRoomRunContext()` and threaded as `dep1`:

```ts
// app/model/room.model.ts
export interface RoomRunContext {
  token: number;
  slug: string;
  profile: ConfirmedProfile;
  runId: string | null;
  self: PeerIdentity | null;
  other: PeerIdentity | null;
  runTimestamp: string | null;
  selfProfile: PeerProfile | null;
  otherProfile: PeerProfile | null;
  connectionType: ConnectionType;
  phase: RoomPhase;
  terminal: boolean;
  testConfig: TestConfigPayload | null;
}
```

```ts
// app/hooks/room-session.hook.ts
export function useRoomSession(token: number | null, profile: ConfirmedProfile | null) {
  const ctx = useRoomRunContext(token, profile);

  const { send, close }               = useSignalingSocket(ctx, { onEnvelope, onExpired });
  const { connectionType, connectionFor, teardownAll, controlChannel, bulkChannels }
                                      = usePeerConnections(ctx, { send, onMessage, onFailure, onClose });
  const { selfProfile, otherProfile } = usePeerProfileExchange(ctx, controlChannel, { onExchangeComplete });
  const { liveLatency, baseline }     = useLatencySession(ctx, controlChannel, { onSamplingStarted, onHandoff });
  const { stageId, progress }         = useStageOrchestrator(ctx, bulkChannels, { onStagesDone, onTimeout });
  const { outcome, finalize }         = useTerminalController(ctx, { send, freezeStages, getPeers });

  return { state, cancel };
}
```

Each sub-hook owns its own class instance and timers and returns its own slice.
`room.tsx` sees one destructure.

The cross-hook coupling is real and must be handled deliberately rather than
discovered mid-implementation. Two gates read state owned by several hooks:

- **`maybeStartStages`** needs all bulk channels open **and** `testConfig`
  **and** `latencyReady` **and** `self` **and** `runId` (the S5 gate). It lives
  in `stage-orchestrator.hook.ts` and reads the first two from `ctx` and its own
  props; `latencyReady` arrives as a prop from `useLatencySession`.
- **`finalize`** must be callable from six sites across four hooks. It lives in
  `terminal-controller.hook.ts` and is passed *down* to the others as an option.
  `TerminalController.trigger` is already idempotent, so repeated calls stay safe.

Hook ordering in the composite is therefore load-bearing and is fixed by the
data flow above.

## Implementation Phases

Every phase ends with `bun run typecheck` green and `bun run test` at the
recorded baseline. Phases 1.1–1.11 are strictly leaf-first so no phase leaves a
dangling import.

### Phase 1: Model layer

Mechanical moves. Each step: create the `.model.ts`, move the declarations and
their guards, delete the originals, rewrite every import, run typecheck.

#### 1.1 `geo.model.ts`
**Files**: `app/model/geo.model.ts` ← `app/lib/geo.ts`
- Move: `GeoInfo`, `STRING_FIELDS`, `BOOLEAN_FIELDS`, `sanitizeGeo`,
  `projectGeoForAnonymous`. Add `GeoPoint = Required<Pick<GeoInfo, "lat" | "lon">>`
  and `AnonymousGeo = Pick<GeoInfo, "proxy" | "hosting">`.
- Leave in `lib/geo.ts`: `fetchGeo`, `prefetchGeo`, `resetGeoPrefetch`, endpoint
  constant, `unwrapGeoPayload`.
- Risk: **Low**. `geo.test.ts` imports both halves; split its imports.

#### 1.2 `signaling.model.ts`
**Files**: `app/model/signaling.model.ts` ← `app/lib/protocol.ts` (deleted)
- Move the whole file. `Slot` is declared **here only**; delete the duplicate
  from `stage.ts` and re-export nothing.
- Update `workers/signaling-room.ts` to import `~/model/signaling.model`.
- Risk: **Medium** — the only step that touches the Worker. Confirm the workerd
  vitest project still resolves `~/*` (it uses `tsconfigPaths: true`, and
  `tsconfig.cloudflare.json` already maps `~/*` → `./app/*`).
- Verify: the 6 known `signaling-room.test.ts` failures stay at 6.

#### 1.3 `stage.model.ts`
**Files**: `app/model/stage.model.ts` ← `app/lib/stage.ts` (deleted)
- Move: `StageId`, `StageName`, `DOWNLOAD`/`UPLOAD`/`DUPLEX`, `STAGE_ORDER`,
  `BandwidthGroup`, `stageName`, `isStageId`, `bandwidthGroup`, `otherSlot`,
  `isSender`, `isReceiver`, `senderSlotFor`, `edgeKey`, `allEdgeKeys`.
- `Measurement`, `StageBankEntry`, `isValidMeasurement` go to 1.4 instead.
- Risk: **Low**.

#### 1.4 `measurement.model.ts`
**Files**: `app/model/measurement.model.ts`
- Sources: `Measurement`/`StageBankEntry`/`isValidMeasurement` (`stage.ts`),
  `ReceiverSnapshot`/`SealedMeasurement` (`throughput.ts`),
  `Sample`/`Aggregate`/`LiveLatency` (`latency.ts`),
  `StageProgressSnapshot` (`control-channel.ts`).
- Apply the collapses shown above. Delete `ReceiverSnapshot`,
  `StageProgressSnapshot`, `SealedMeasurement`, `Aggregate` as separate
  declarations.
- Risk: **Medium** — five call-site families rename at once. The field
  equivalences were verified above, so failures here are import errors, not
  logic errors.

#### 1.5 `connection.model.ts`
**Files**: `app/model/connection.model.ts` ← `app/lib/webrtc.ts`
- Move: `ConnectionType`, `ChannelLabel`, `OwnAddress`, `BULK_CONNECTION_COUNT`,
  `CONTROL_CONN_INDEX`, `bulkConnIndex`.
- Delete `ConnectionRole` (identical alias of `ChannelLabel`).
- Risk: **Low**.

#### 1.6 `peer.model.ts` — the main collapse
**Files**: `app/model/peer.model.ts`
- Introduce `PeerData` and its six utilities exactly as specified above.
- Delete: `PeerProfileMessage`, `ReceivedPeerProfile`, `ValidatedInitialProfile`,
  `ProfileEnvelope`, `AssemblePeerInfo`, `TerminalPeerInfo`, `VisualProfileInput`,
  `room.tsx`'s local `PeerInfo`, `result-validate.ts`'s private `Peer`.
- Move guards/constants: `PRIVACY_LEVELS`, `DEFAULT_PRIVACY_LEVEL`,
  `NAME_MAX_LENGTH`, `UA_MAX_LENGTH`, `sanitizeText`, `isPrivacyLevel`,
  `isValidIp`, `maskIp`, IP patterns, `fallbackPeerName`.
- Leave in `lib/peer-profile.ts`: `nameFromUserAgent`, `defaultNameForLevel`,
  `loadStoredProfile`, `saveProfile`, `defaultProfile`, `addressFields`,
  `geoField`, `buildInitialProfileMessage`, `buildEnrichmentProfileMessage`,
  `sanitizeIncomingProfile`, `validateInitialProfile`.
- `ResultPeer` moves to `result.model.ts` in 1.7 but is *defined* as a `Pick` of
  `PeerData` — `result.model.ts` imports `peer.model.ts`, never the reverse.
- Risk: **High** — touches 10 files. Depends on 1.1–1.5.
- Edge case: `validateInitialProfile` currently returns a distinct type carrying
  `timestamp`. It now returns `PeerProfile`, and the slot-0 timestamp check
  narrows to `InitialProfile`. The call site in `room.tsx` already branches on
  `validated.timestamp`, so behaviour is unchanged.

#### 1.7 `result.model.ts` + `storage.model.ts`
**Files**: `app/model/result.model.ts`, `app/model/storage.model.ts`
- `result.model.ts`: `ResultStatus`, `BandwidthEdge`, `ResultData`,
  `ResultMetadata`, `P2PSpeedtestResult`, `ResultPeer`, `ResultShare`,
  `SUPPORTED_API_VERSION`, `buildMetadata`.
- Delete `ViaType`; `ResultData.via` is `ConnectionType`.
- Delete `result-validate.ts`'s four private re-declarations (`BandwidthEdge`,
  `Peer`, `ResultData`, `Envelope`) and import the real ones.
- `storage.model.ts`: `SaveResultOutcome`, `ListResultsOutcome`,
  `GetResultOutcome`, `ExportBundle`, `BuildExportOutcome`, `ImportEntryOutcome`,
  `ImportEntryResult`, `ImportResultsOutcome`, `ValidationResult`.
- **Schema lock**: add a compile-time assertion in `result-validate.test.ts` that
  `ResultPeer`'s key set equals the schema's `peer.properties` key set, so a
  future `Pick` that widens fails typecheck rather than IndexedDB writes.
  ```ts
  type SchemaPeerKeys = "id" | "name" | "ua" | "ip" | "protocol" | "geo";
  type _Exact = [keyof ResultPeer] extends [SchemaPeerKeys]
    ? [SchemaPeerKeys] extends [keyof ResultPeer] ? true : never
    : never;
  const _assert: _Exact = true;
  ```
- Risk: **Medium**. `additionalProperties: false` means a widening is a runtime
  storage failure; the assertion above is the mitigation.

#### 1.8 `control-message.model.ts`
**Files**: `app/model/control-message.model.ts`, `app/lib/control-message.ts`
- Merge `LatencyMessage` (4 variants), `StageMessage` (9 variants) and the
  `peer-profile` envelope into one `ControlMessage` union with a shared
  `{ runId: string }` base.
- Merge the three decoders into `decodeControlMessage`, moving each type's
  validation branch verbatim.
- Delete `decodeLatencyMessage`, `decodeStageMessage`, `decodeProfileEnvelope`,
  `encodeProfileEnvelope` (becomes `encodeControlMessage`).
- Risk: **High** — 1,063 lines of existing tests (`control-channel.test.ts`,
  `latency.test.ts`) assert per-type accept/reject. Port their assertions to the
  merged decoder rather than rewriting them; every currently-rejected input must
  still be rejected for the same reason.

#### 1.9 `bulk-frame.model.ts`
**Files**: `app/model/bulk-frame.model.ts` ← `app/lib/throughput.ts`
- Move: `BulkFrameKind`, `BulkFrame`, `BulkChannel`, `BULK_FRAME_HEADER_BYTES`,
  `KIND_CODES`, `KIND_NAMES`. Encode/decode functions stay in `lib/throughput.ts`.
- Risk: **Low**.

#### 1.10 `presentation.model.ts`, `speed-series.model.ts`, `globe.model.ts`
**Files**: three new models
- `presentation.model.ts`: `RoomPhase` (single definition; `room.tsx`'s `Phase`
  deleted), `TransferMode`, `TransferToken`, `TransferChannel`,
  `LiveTestPresentation`, `PeerView`, and `LiveTestRoomView` as the `Pick<RoomState, …>`
  shown above. `VisualPeer` → `PeerView`; `VisualLocation` → `GeoPoint`;
  `VisualProfileInput` deleted.
- `speed-series.model.ts`: `SeriesPoint`, `Series`, `SpeedSeriesState`,
  `MAX_POINTS_PER_SERIES`.
- `globe.model.ts`: `GlobeLayout`, `Vec3`, `Quat`, `QualityTier`,
  `QualitySettings`, `QUALITY`, `GlobeStream`, `GlobeFrame`, `LabelPlacement`,
  `LabelPlacements`, `GlobeDiagnostics`, `GlobeScene`, `GlobeSceneOptions`,
  `GlobeSceneFactory`, `DESKTOP_MIN_WIDTH`. `LatLon` deleted in favour of `GeoPoint`.
- `lib/test-visualization.ts` → `lib/presentation-selector.ts` (functions only).
- Risk: **Medium**. `globe-math.ts` (455 lines) and its 477-line test use `LatLon`
  throughout — a pure rename.
- Note: `presentation.model.ts` importing `room.model.ts` while `room.model.ts`
  imports `presentation.model.ts` for `RoomPhase` would be circular. Resolve by
  putting `RoomPhase` in `room.model.ts` and having `presentation.model.ts`
  import from it, one direction only.

#### 1.11 `room.model.ts`
**Files**: `app/model/room.model.ts`
- `RoomPhase`, `RoomState`, `RoomRunContext`, `TerminalReason`,
  `LocalFailureReason`, `FinalizeTrigger`, `TerminalOutcome`.
- Risk: **Low** — nothing consumes it until Phase 5.

### Phase 2: `app/lib` becomes behaviour-only

#### 2.1 Split `control-channel.ts` (969 lines)
**Files**: `app/lib/stage-orchestrator.ts`, `app/lib/terminal-controller.ts`
- Two classes, two files, no shared state between them beyond the models.
- Options interfaces stay next to their class (they are constructor arguments,
  not domain models).
- Split `control-channel.test.ts` to match.
- Risk: **Medium** — a mechanical file split; the classes do not reference each
  other today.

#### 2.2 Rename `results.ts` → `results-store.ts`
- Keep IndexedDB, assembly, export/import behaviour. Types now come from
  `result.model.ts` / `storage.model.ts`.
- `bpsToMbps`, `buildResultCopyText`, `buildResultLink` stay.
- Risk: **Low**.

#### 2.3 Comment sweep across `app/lib`
- Apply the comment policy to every `lib` module.
- Risk: **Low**, but do it as its own commit so the behavioural diff of 2.1/2.2
  stays reviewable.

### Phase 3: Leaf UI hooks

No room dependency; each is independently testable.

| Hook | Replaces | Risk |
|---|---|---|
| `reduced-motion.hook.ts` | `components/speedtest/use-reduced-motion.ts` (move) | Low |
| `document-visible.hook.ts` | `useDocumentVisible` inside `PeerGlobe.tsx` | Low |
| `element-box.hook.ts` | the two-box `ResizeObserver` effect in `PeerGlobe.tsx` | Medium |
| `portal-host.hook.ts` | the `<body>` portal effect in `PeerGlobe.tsx` | Medium |
| `animated-scalar.hook.ts` | the identical create/dispose/set triple in `SpeedGauge.tsx` **and** `RealtimeSpeedGraph.tsx` | Low |
| `svg-draw-in.hook.ts` | the dynamic-import draw-in effect in `RealtimeSpeedGraph.tsx` | Low |
| `speed-series.hook.ts` | the `recordSample` effect in `LiveTestDashboard.tsx` | Low |
| `clipboard-copy.hook.ts` | `copied` state + timeout in `ShareActions.tsx` | Low |

`element-box.hook.ts` note: the current effect observes two elements with one
`ResizeObserver` and dispatches by `entry.target`. The hook takes an array of
refs and returns an array of boxes, preserving the single-observer behaviour —
two separate observers would change resize-callback ordering.

`animated-scalar.hook.ts` shape:
```ts
const { set } = useAnimatedScalar(write, { duration: 260, ease: "outQuad" }, [radius]);
```
The dependency array reproduces `SpeedGauge`'s current `[radius]` re-creation.

### Phase 4: Visualization components onto hooks

#### 4.1 `PeerGlobe.tsx`: 429 lines → ~90
**File**: `app/components/speedtest/PeerGlobe.tsx`, `app/hooks/globe-scene.hook.ts`
- `useGlobeScene(refs, presentation, opts)` returns `{ failed }` and absorbs
  scene creation, the StrictMode cancel/dispose dance, `resize`, `update`,
  `setActive`, the failure latch, and the per-run failure reset.
- `buildFrame`, `readToken`, `parseCssColor`, `FALLBACK_COLORS` move to
  `app/lib/globe-frame.ts` (pure; `PeerGlobe.test.tsx` imports `buildFrame`
  directly today, so keep it exported).
- The component keeps only: the placeholder div, the portal, the canvas, two
  `MarkerLabel`s, the failure panel.
- Risk: **High**. `PeerGlobe.test.tsx` (464 lines) asserts StrictMode
  mount/unmount/remount disposal and that an async factory resolving after
  unmount disposes rather than leaking. The `cancelled` flag and
  `failedRef` semantics must move intact.
- Preserve exactly: the `DEV`-only `<main>` `position: static` warning, and
  `insertBefore(host, document.body.firstChild)` (not `prepend` — the Workers
  types shadow the DOM signature).

#### 4.2 `SpeedGauge.tsx` / `RealtimeSpeedGraph.tsx`
- `GaugeChannel` and `SeriesReadout` each drop to one `useAnimatedScalar` call.
- `GraphSeries` drops to one `useSvgDrawIn` call.
- Pure SVG geometry helpers (`polar`, `arcPath`, `angleFor`, `xFor`, `yFor`,
  `pointsFor`, `formatMbps`) move to `app/lib/gauge-geometry.ts` and
  `app/lib/graph-geometry.ts`. `formatMbps` is currently defined identically in
  both files plus a third variant in `room.tsx` — one definition.
- Risk: **Medium**. `SpeedWidgets.anime.test.tsx` asserts that exactly one
  animatable is created per channel and disposed on unmount.

#### 4.3 `LiveTestDashboard.tsx`
- One `useSpeedSeries(presentation)` call replaces its effect.
- Risk: **Low**.

### Phase 5: Room session hooks

The largest phase. Build the hooks against the existing `room.tsx` behaviour one
at a time; `room.tsx` is only rewritten in Phase 6.

#### 5.1 `useRoomRunContext`
- One `useRef<RoomRunContext>`, plus typed setters that keep the React mirror
  state in sync (the current `updatePhase` pattern, generalised).
- Risk: **Low**.

#### 5.2 `signaling-socket.hook.ts`
- Owns the WebSocket, the `getTabSessionId` sessionStorage nonce, the close
  handler, and `sendEnvelope`.
- **Preserve exactly**: the `setTimeout(…, 0)` deferral that makes StrictMode's
  synthetic first cleanup run before any socket opens, and `EXPIRED_CLOSE_CODE`
  handling.
- Risk: **Medium**.

#### 5.3 `peer-connections.hook.ts`
- Owns the control connection plus `BULK_CONNECTION_COUNT` bulk connections,
  `connectionForIndex`, `recomputeConnectionType`, `teardownAllConnections`,
  `safeGetOwnAddress`.
- **Preserve exactly**: the RELAY > DIRECT > UNKNOWN aggregation, the
  `forceRelay` query switch, and the `if (controlConnRef.current) break` guard
  that makes `ice-servers` idempotent.
- Risk: **Medium**.

#### 5.4 `peer-profile-exchange.hook.ts`
- Owns initial send, the geo enrichment tail, inbound validation/sanitisation,
  the `PROFILE_TIMEOUT_MS` timer, and the `channel-ready` half of the barrier.
- **Preserve exactly**: the two `terminalRef.current || runIdRef.current !== runId`
  re-checks after each `await`, and that a failed enrichment never looks like a
  failed initial send.
- Risk: **High** — the ordering here gates the whole test.

#### 5.5 `latency-session.hook.ts`
- Owns `LatencySession`, the live/baseline state, and handoff routing.
- **Preserve exactly**: `LatencySession` is constructed synchronously before any
  `await` in the channel-open path, so `sendChannelReady` can never be called on
  a missing instance; and only `latency-ready-timeout` calls `enterTerminal` from
  the handoff (the other two reasons already have their own trigger sites).
- Risk: **Medium**.

#### 5.6 `stage-orchestrator.hook.ts`
- Owns `StageOrchestrator`, `maybeStartStages` (the S5 gate), stage state, and
  the run-tagged progress bank.
- **Preserve exactly**: the five-way gate, and that a progress bank from a
  previous run is dropped rather than merged.
- Risk: **Medium**.

#### 5.7 `terminal-controller.hook.ts`
- Owns `TerminalController`, `ensureTerminalController`, `finalize`,
  `abortPreMeasurement`, `enterTerminal`, `measurementStarted`, and the
  `LIFECYCLE_GRACE_MS` timer.
- **Preserve exactly**: `finalize` idempotency, the `run-finished` send, the
  grace-timer teardown, and that `run-ended` after measurement clears the grace
  timer and tears down immediately.
- Risk: **High** — this is the abort table.

#### 5.8 `room-session.hook.ts`
- Compose 5.1–5.7 in the fixed order, own the inbound envelope switch and the
  control-message routing switch, and assemble `RoomState`.
- Risk: **High**.

#### 5.9 `confirmed-profile.hook.ts`, `geo-prefetch.hook.ts`, `live-presentation.hook.ts`, `visual-failure.hook.ts`, `room-link.hook.ts`
- Small hooks for the remaining `room.tsx` effects and derivations.
- `geo-prefetch.hook.ts` covers both the mount prefetch and the
  provisional-self-marker effect, keeping the `prev ?? …` rule that lets the real
  `peer-profile` message always win.
- Risk: **Low**.

### Phase 6: Routes

#### 6.1 `room.tsx`: 1259 lines → ~220
- One `useRoomSession` destructure, one `useLivePresentation`, one
  `useVisualFailure`, one `useRoomLink`, one `useConfirmedProfile`.
- Extract the JSX blocks unchanged into
  `app/components/room/RoomSummary.tsx`, `ProfileGate.tsx`,
  `TerminalPanel.tsx`, `TestPanel.tsx`, `ResultSummary.tsx`, `PeerSummary.tsx`.
- **The markup must be moved byte-for-byte.** Class strings, copy and element
  order do not change.
- Risk: **High** for behaviour, **Low** for markup if moved verbatim.

#### 6.2 `results.tsx`
- `const { state, selected, toggle, exportAll, exportSelected, importFile, importing, messages } = useResultHistory()`.
- Risk: **Low**.

#### 6.3 `results.$room.$peerId.tsx`
- `const { state } = useStoredResult(room, peerId)`; the 60-line IIFE inside JSX
  becomes a `<ResultDetailBody result={…} />` component.
- Risk: **Low**.

#### 6.4 `home.tsx`
- `useConfirmedProfile` + `useCreateRoom` / `useJoinRoom`.
- Risk: **Low**.

#### 6.5 `dev.live-view.tsx`
- Update imports; the fixture stays as-is.
- Risk: **Low**.

### Phase 7: Sweep and verify

- 7.1 Delete dead exports; confirm nothing in `app/lib/**` exports a domain
  interface.
- 7.2 Final comment pass over `app/components` and `app/routes`.
- 7.3 Full verification (see Success Criteria).

## Risks & Mitigations

- **Risk**: A room-FSM ordering rule is lost while splitting the 580-line effect.
  - Mitigation: Phases 5.2–5.7 each list the invariants they must preserve. Move
    code verbatim into the hook first, then simplify in a separate commit, so a
    regression is bisectable to one small diff.
- **Risk**: `ResultPeer` widens and breaks `additionalProperties: false` at
  runtime rather than at compile time.
  - Mitigation: the type-level key-set assertion in Phase 1.7, plus the existing
    `result-validate.test.ts` and `results.test.ts` round trips.
- **Risk**: Merging three decoders into one loosens a rejection rule.
  - Mitigation: port existing per-type assertions rather than rewriting them;
    1,063 lines of decoder tests already exist.
- **Risk**: A `.model.ts` touches a DOM/browser global and breaks the workerd
  vitest project.
  - Mitigation: models are types, guards and plain constants only. No `window`,
    `document`, `indexedDB`, `matchMedia` or `performance` at module scope.
- **Risk**: Circular imports between model files.
  - Mitigation: fixed dependency order —
    `geo` → `signaling` → `stage` → `connection` → `measurement` →
    `bulk-frame` → `peer` → `result` → `storage` → `control-message` →
    `room` → `presentation` → `speed-series` → `globe`. A model may only import
    from earlier in this list.
- **Risk**: UI drifts while markup moves between files.
  - Mitigation: move JSX verbatim; review the Phase 6 diff for any change to a
    class string, text node, `data-testid` or element order. `LiveTestDashboard.test.tsx`,
    `SpeedWidgets.test.tsx` and `PeerGlobe.test.tsx` assert on testids and copy.
- **Risk**: StrictMode double-invocation behaviour changes when effects move into
  hooks.
  - Mitigation: `PeerGlobe.test.tsx` already covers this for the globe. Phase 5.2
    must keep the `setTimeout(…, 0)` socket deferral; add a case asserting one
    socket per mount if one does not already exist.
- **Risk**: The 6 pre-existing `signaling-room.test.ts` failures mask a new
  regression.
  - Mitigation: compare failing test *names*, not just the count, after every
    phase.

## Success Criteria

- [ ] `bun run typecheck` passes.
- [ ] `bun run test` fails only the 6 recorded `workers/signaling-room.test.ts`
      tests, by name.
- [ ] `app/model/` contains every domain type; `grep -rn "^export interface\|^export type" app/lib` returns only options/callback types local to a class or function.
- [ ] Zero occurrences of `ReceivedPeerProfile`, `PeerProfileMessage`,
      `ValidatedInitialProfile`, `ResultPeer` (as a standalone interface),
      `AssemblePeerInfo`, `TerminalPeerInfo`, `VisualPeer`, `VisualProfileInput`,
      `VisualLocation`, `ViaType`, `ConnectionRole`, `ReceiverSnapshot`,
      `StageProgressSnapshot`, `LatLon`, or a second `Slot` declaration.
- [ ] `room.tsx` under 250 lines, no `useRef`, no `useEffect`.
- [ ] `PeerGlobe.tsx` under 120 lines, at most one `useEffect`.
- [ ] Every hook in `app/hooks/` is consumed by destructuring.
- [ ] No component `useEffect` contains more than a single hook-to-prop wiring.
- [ ] `git diff` over `app/components/**` and `app/routes/**` shows no change to
      any class string, visible text, or `data-testid`.
- [ ] Total comment lines across `app/` reduced to roughly 250, with protocol
      invariants retained.

## Implementation Order

Phase 1 must run in the 1.1 → 1.11 order above; it is a dependency chain and no
step is independently mergeable without the ones before it. Phase 1 as a whole is
independently mergeable and is the highest-value half of this plan.

Phase 2 depends on Phase 1 only. Phase 3 depends on Phase 1 (models) and is
otherwise independent of Phase 2 — the two can proceed in parallel. Phase 4
depends on Phase 3. Phases 5 and 4 are independent of each other. Phase 6 depends
on 4 and 5. Phase 7 is last.

Recommended merge boundaries: after 1.11, after 2.3, after 4.3, after 5.9, after
6.5, after 7.3.
