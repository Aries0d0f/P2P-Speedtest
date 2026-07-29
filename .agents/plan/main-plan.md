# P2P Speedtest — Main Plan

> **Status**: APPROVED
> **Created**: 2026-07-29
> **Updated**: 2026-07-29

## Purpose and authority

This document defines the product goal, boundaries, user experience, system
shape, and hard requirements. Change it first when product behaviour changes.

- The numbered specs below are normative.
- The result schema is the field-level contract:
  [`p2p-speedtest-result.v1.schema.yaml`](../../schemas/p2p-speedtest-result.v1.schema.yaml).
- The phase plans own implementation detail such as modules, protocols,
  constants, error codes, algorithms, and test procedures. They must conform
  to this plan and the schema.

Implementation plans:
[Phase 1](./01-signaling-backbone.md) ·
[Phase 2](./02-webrtc-connection.md) ·
[Phase 3](./03-latency-measurement.md) ·
[Phase 4](./04-throughput-measurement.md) ·
[Phase 5](./05-results-polish.md) ·
[Phase 6](./06-live-test-visualization.md)

## Goal

Build a browser tool that measures the real network connection between two
people's devices.

The peers meet through a short-lived signaling room, establish an encrypted
WebRTC connection, and measure latency, jitter, loss, and throughput in both
directions. Results remain in each browser.

The Worker and Durable Object introduce the peers but never receive
application profiles, test traffic, measurements, or results. WebRTC
signaling still carries SDP/ICE data, and the service necessarily observes
connection metadata such as source IPs. If a direct path is not possible,
TURN may relay encrypted test traffic; that fact must be clear to both users
and permanently recorded.

## User stories

1. As a host, I can create a room and share a link, QR code, Room ID, or emoji
   key without creating an account.
2. As a guest, I can join with any shared representation without knowing an
   IP address or configuring a network.
3. As either peer, I confirm my display name and privacy level before joining.
4. As either peer, I can see who I connected to and whether the path is direct
   or relayed before measurement starts.
5. As either peer, I see our shared locations and transfer path on an
   auto-oriented globe, alongside live latency and throughput, while the
   same three-stage test runs on both devices.
6. As either peer, I receive an honest result, including partial results when
   measurement started but could not finish.
7. As a returning user, I can view, export, import, and copy results stored in
   my browser.

## Boundaries

### In scope

- Two peers per short-lived room.
- Direct WebRTC with STUN and TURN fallback.
- Current Chrome, Firefox, and Safari on desktop and mobile.
- Local result history, import/export, and local result links.
- A responsive, animated live-test dashboard with a 3D geographic view and
  accessible numeric equivalents.
- Clear handling of waiting, pairing, testing, cancellation, failure, expiry,
  and partial results.

### Out of scope

- Accounts, any server-side result storage/database, or cross-device sync.
- More than two peers in a room.
- Multiple test runs in one room.
- Hiding a peer's network address from the other peer at the WebRTC layer.
- Supporting multiple TURN providers at the same time.
- Treating imported checksums as proof that a result came from this app.

## High-level structure

| Part | Responsibility |
|---|---|
| Browser app | Confirmation UI, WebRTC, peer profile exchange, all measurement, result assembly, local storage, and all result views |
| Worker | Room creation, request routing, and per-IP rate limits |
| `SignalingRoom` Durable Object | One short-lived room: peer slots, signaling relay, room/run lifecycle, ICE configuration, and shared test parameters |
| TURN provider | Relays encrypted WebRTC traffic only when a direct path cannot be established |

Public surfaces:

| Path | Purpose |
|---|---|
| `POST /api/rooms` | Create a room |
| `/api/room/:roomToken` | WebSocket signaling channel |
| `/` | Create or join |
| `/room/:slug` | Pair, test, and show the current result |
| `/results` | Local result history |
| `/results/:room/:peerId` | One locally stored result |

## Hard specs

### S1 — Room identity and joining

- The server generates one random **42-bit room token**.
- All join forms reversibly encode that same token; there is no lookup table:

  | Form | Contract |
  |---|---|
  | Room ID / slug | 9-character, zero-padded Crockford base32 |
  | Emoji key | 7 characters from a fixed 64-entry emoji alphabet |
  | Link / QR | `/room/<slug>` on the current host |

- A single join input accepts a Room ID, emoji key, or shared room link.
- Emoji keys are copy/paste values; there is no emoji picker.
- Creation and join attempts are rate-limited per source IP.
- A room has a non-refreshable hard expiry of about 10 minutes from
  reservation. Token collisions are retried.

### S2 — Room and run lifecycle

- A room has at most two slots, assigned by socket arrival: slot 0, then slot
  1. A slot is a position, not a host/guest identity.
- Before a run starts, a stale waiting socket may be replaced; a live socket
  may not be evicted.
- The second live socket starts the room's single run. From that point, slots
  cannot be replaced.
- When that run ends for any reason, the room is terminal. Another test
  requires another room.
- Hard expiry is fixed and always wins. A separate refreshable idle timeout
  may clean up inactive rooms earlier.
- Run-scoped signaling rejects messages for another run.
- The room stores only lifecycle state needed to operate. Signaling may
  transiently relay SDP/ICE candidates, including candidate addresses, but
  does not retain them as peer data. Application profile fields, measurements,
  and results never enter signaling or Durable Object storage.

### S3 — Peer identity and privacy

- The Durable Object assigns each accepted socket a new UUIDv5 `peer-id`.
  The id is server-issued, run-local, and changes when a stale slot is taken
  over.
- Each browser sends its own name and optional user-agent, address, protocol,
  and geolocation directly to the other peer over the encrypted data channel.
  Geo lookup is best effort and never blocks pairing.
- Each peer independently chooses a privacy level before joining:

  | Level | Name | User-agent | IP | Geo |
  |---|---|---|---|---|
  | Off (default) | shared | shared | full | full |
  | On | shared | omitted | full | full |
  | Anonymous | shared | omitted | masked | `proxy` and `hosting` only |

- Application-profile withholding and masking happen before that profile
  leaves the sender.
- Privacy mode controls what the application profile shares, displays, and
  stores. It does not hide the source IP from the service or network-layer
  ICE addresses from the service and a determined peer.

### S4 — Connectivity and relay disclosure

- Peers use public STUN and short-lived TURN credentials. No static TURN
  secret is shipped to clients.
- Credentials are issued through the accepted signaling socket once per peer
  and run, and never outlive the room.
- TURN failure falls back to STUN-only; pairing may then fail on hard NATs.
- The selected connection is recorded as:

  | Value | Meaning |
  |---|---|
  | `DIRECT` | Neither side of the selected ICE pair is relayed |
  | `RELAY` | At least one side uses a relay candidate |
  | `UNKNOWN` | No reliable classification was available |

- The connection type is shown as a persistent badge before testing, on the
  result, and in copied result text. A relayed result must never look direct.

### S5 — Measurement

- A reliable ordered control channel carries coordination, ping/pong,
  profiles, and result exchange.
- One or more unordered, non-retransmitting bulk channels carry throughput
  payloads.
- Both peers measure RTT with their own clocks. Jitter is derived from
  consecutive RTT samples.
- Throughput is receiver-observed, excludes ramp-up, and respects channel
  backpressure.
- Loss is receiver-observed from missing bulk sequence numbers.
- A full test runs exactly three stages in this order:

  | Stage | Traffic | Stored group |
  |---|---|---|
  | Download | slot 0 → slot 1 | `directional` |
  | Upload | slot 1 → slot 0 | `directional` |
  | Duplex | both directions together | `duplex` |

- Slot mapping is fixed and both browsers use the same labels.
- Every stored edge carries speed, latency, jitter, and loss observed during
  that stage. Directional and duplex groups remain separate and are never
  averaged together.

### S6 — Result contract and failure boundary

- The canonical envelope is `P2PSpeedtestResult` at
  `sws.aries0d0f.me/v1`; the schema owns its exact field shape and units.
- Each peer independently assembles and stores its own record. Result data
  never passes through the server.
- Both peer entries are always present once measurement begins. Missing
  profile detail uses a slot-based fallback name.
- Assembly is deterministic: peers and edges are ordered by slot, and slot 0
  authors the shared run timestamp before measurement begins. The field
  identifies when the run began; it is not a completion timestamp.
- `SUCCEED` requires all three stages and both edges in both bandwidth groups.
  Otherwise the record is `FAILED` or `CANCELED` and contains only what that
  browser actually knows.
- Status resolution is deterministic: `FAILED` outranks `CANCELED`;
  `SUCCEED` requires both peers to report success.
- A run ending before measurement starts writes no record. Once measurement
  starts, every surviving peer writes an honest full or partial record.
- A peer never waits for a server to finalize a result. If peer-to-peer result
  exchange fails, each survivor stores its own available half.
- `hash` is a deterministic integrity checksum over `data`. It detects
  corruption, not origin or authenticity.
- Speed is stored in bits per second; loss is stored as a fraction from 0 to
  1. Display-unit conversion belongs to the UI.

### S7 — Local history and portability

- Results are immutable local-browser records. Each browser writes at most one
  record for the identity `metadata.peer-id + data.room`.
- Import and local writes merge first-write-wins; existing records are never
  overwritten.
- Export uses `{ results: [...] }` and round-trips full envelopes.
- Import validates each entry independently for schema shape, semantic
  consistency, and checksum. Invalid entries are skipped with visible
  warnings without rejecting valid siblings.
- Result links are local-only. Export/import is the cross-browser portability
  path.

### S8 — Product flow and pages

- Both create and join flow through the same name/privacy confirmation before
  the browser enters a room.
- The room page owns one state machine:

  `waiting → pairing → paired → testing → finalizing → result`

- Before a run starts, losing the only waiting peer leaves the room available
  for another peer. After the run starts, every success, failure,
  cancellation, disconnect, or expiry is terminal and offers a new-room path.
- The results pages read local storage only and perform no network work.
- Current result, history list, and result detail clearly render successful,
  failed, canceled, partial, direct, relayed, and unknown outcomes.

### S9 — Platform integration

- The existing React Router app remains the UI and SSR surface.
- The Worker handles `/api/*` before React Router fallback.
- The Durable Object is exported, bound, and migrated in the Worker
  configuration.
- UI routes continue to SSR normally after API dispatch is added.

### S10 — Abuse and cost boundaries

- Per-IP room creation and join limits reduce online room discovery.
- Socket-bound, per-run, expiry-capped TURN credentials bound relay access.
- Server-issued test parameters keep honest clients comparable but are not a
  security control; the server is not in the data path and cannot enforce a
  modified client's transfer volume or reported measurements.

### S11 — Live test visualization

- During testing, both peers see a dotted 3D Earth with a world map and every
  available peer location. A hidden or unavailable location is stated
  clearly and never blocks the test.
- Available peer locations are joined by the shortest raised route. The
  globe keeps both peers visible, preserving Earth's real axial tilt on
  desktop and placing the current peer left and the other peer right on
  mobile.
- The route and animated packages are cyan when this browser receives,
  violet when it sends, and green in both directions during duplex.
- A live speed graph and dashboard-style gauge accompany the globe. Duplex
  directions remain visibly separate rather than being combined.
- The dashboard is an enhancement: live numeric metrics, status, and test
  controls remain usable if a location or visual effect is unavailable, and
  visualization never changes the measurement or result.

## Delivery map

Each phase must leave a working, demonstrable increment.

| Phase | Outcome | Primary specs |
|---|---|---|
| 1 — Signaling backbone | Rooms, identity encodings, two-peer lifecycle, signaling, rate limits, Worker integration | S1, S2, S3 identity, S9, S10 |
| 2 — WebRTC connection | STUN/TURN connection, data channels, relay badge, confirmation, peer profile exchange | S3, S4, S8 |
| 3 — Latency | Symmetric live RTT and jitter over the control channel | S5 |
| 4 — Throughput and records | Three measurement stages, loss, result exchange, validation, checksum, local write | S5, S6, S10 |
| 5 — Results and sign-off | History/detail, import/export, sharing, robustness, responsive and browser verification | S7, S8 |
| 6 — Live test visualization | Peer globe, transfer visualization, live graph and gauge, graceful fallback | S8, S11 |

Phases are implemented in order. Detailed work, dependencies, risks, and
exit checks live in the linked phase plans.

## Product acceptance

- [ ] Link, QR, Room ID, and emoji key resolve to the same room.
- [ ] Two browsers connect directly when possible and through TURN when
      required, with an accurate persistent connection badge.
- [ ] Privacy choices are independently enforced at the sending peer and the
      signaling path contains no peer profile or result data.
- [ ] Both peers see live latency, jitter, loss, and throughput.
- [ ] With two shared locations, both peers see the same shorter geographic
      route and both markers remain visible; desktop preserves Earth's axial
      tilt and mobile places self left/peer right.
- [ ] Directional arc, particles, graph, and gauge use local-scope cyan
      receive / violet send semantics, while duplex shows two green
      directions without combining their measurements.
- [ ] An unavailable location or visual enhancement retains usable numeric
      metrics and controls and does not alter the measurement or result.
- [ ] Download, upload, and duplex run in order and remain distinct in the
      stored and displayed result.
- [ ] A complete run produces schema-valid, byte-identical `data` and hashes
      in both browsers.
- [ ] Pre-measurement failures store nothing; post-measurement failures and
      cancellations store valid partial results for each surviving peer.
- [ ] Rooms enforce the two-peer, one-run, hard-expiry lifecycle without
      evicting a live waiting peer.
- [ ] Local history, detail, export, import, and sharing work for complete and
      partial records without server storage.
- [ ] Home, room, and results surfaces work on current desktop and mobile
      Chrome, Firefox, and Safari, including forced relay.
- [ ] API dispatch, Durable Object binding/migration, typecheck, tests, and
      production build pass.

## Review Feedback (Codex, 2026-07-29)

### Review State
- **Status: APPROVED**

### Assessment
- S1–S11, the result schema, and the six implementation plans form one
  coherent product contract. Phase-specific technology, algorithms,
  fallbacks, performance budgets, and test procedures live in
  [Phase 6](./06-live-test-visualization.md), not this main plan.
