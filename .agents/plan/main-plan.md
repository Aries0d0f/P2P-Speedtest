# Main Plan: P2P Speedtest (WebRTC + Cloudflare Workers)

> **Status**: APPROVED
> **Created**: 2026-07-29

## Overview

A browser-based tool that lets two users measure the network bandwidth (and
latency) directly between their two machines, using a WebRTC `RTCDataChannel`
for the actual data transfer. Cloudflare Workers + a Durable Object handle
only signaling (session creation and SDP/ICE exchange) — no test traffic ever
passes through Cloudflare's network.

This document is the **guideline** the later, phase-specific implementation
plans must follow. It fixes the architecture, the session/data flow, the
measurement methodology, and the phase breakdown. Implementation plans for
each phase will be created afterward under `.claude/plan/` and must not
contradict the decisions recorded here without updating this file first.

## Requirements

- Two browsers can establish a WebRTC peer connection with minimal
  configuration (no manual IP entry, no port forwarding), including cases
  where one or both sides are behind symmetric NAT / CGNAT via TURN relay.
- Each test session ("room") has its own temporary, unguessable identity.
  One user creates a room; the other joins it via **any one of** a shared
  link/QR code, a typed Room ID, or a copy-pasted 7-character emoji join
  key — the user picks whichever is convenient, all resolve to the same
  room.
- Once connected, the pair runs a speed test measuring:
  - Download throughput (Mbps), from the perspective of the joining peer or
    whichever side is designated "receiver" for that phase
  - Upload throughput (Mbps)
  - Latency (RTT) and jitter
- Both peers see live progress and final results — this is a shared test, not
  a client hitting a server.
- If the connection ends up relayed through TURN (rather than a direct P2P
  path), both peers must be clearly told this, and the result data itself
  must record that the measurement was relayed — a relayed test does not
  measure the same thing as a direct one.
- Cloudflare Worker + Durable Object handle signaling and mint short-lived
  TURN credentials; test traffic itself only touches Cloudflare's network in
  the (disclosed) relayed case.
- Works on current Chrome/Firefox/Safari desktop. Mobile is a stretch goal,
  not a requirement.
- No accounts, no server-side persistence beyond the lifetime of a single
  room. Completed test results persist client-side only, in the browser's
  `localStorage`, as a history the user can revisit, and can be exported to
  a file and re-imported (e.g. on another browser/device) — see decision 7.

## Key Architecture Decisions

These were discussed and fixed with the user; later plans must follow them.

### 1. Signaling: Durable Object room + WebSocket

- One Durable Object instance = one session ("room"), addressed by a single
  **42-bit** random room token — sized to be exactly what a 7-character
  emoji key (decision 3) can carry (`64^7 ≈ 2^42`), since the token, the
  Room ID, and the emoji key are all meant to be pure bijective encodings
  of the *same* value, not three different values needing a lookup table.
  42 bits is deliberately less than a typical 128-bit unguessable secret;
  see the abuse mitigation below for why that's acceptable here.
  `idFromName(token)` addresses the DO. This token is never really "typed"
  by a user directly — it's carried by the join methods in decision 3.
- Each of the two peers opens a WebSocket to `/api/room/:roomToken` (routed
  to the DO via `idFromName`).
- The DO's job: track up to 2 connected peer slots per room (see the
  explicit join/eviction rule below), relay messages between them verbatim
  (SDP offer, SDP answer, ICE candidates, and later a "ready"/"start test"
  handshake), enforce that cap, **and** — per the data-model amendment
  below — assign each connecting peer's `peer-id` at connect time and, once
  both peers report their post-test measurements, finalize and hash-sign
  the canonical result record. See "Amendment (2026-07-29, #2)" for the
  full result-finalization flow; it does not change the DO's core
  signaling-relay role, it adds one more message-relay/compute
  responsibility on top of it.
- **Peer ID assignment**: at WebSocket accept time, alongside slot
  assignment, the DO reads the **server-observed** `CF-Connecting-IP`
  (never a client-reported IP — not spoofable) and computes
  `peer-id = uuidv5(P2P_SPEEDTEST_NAMESPACE, "ip:<CF-Connecting-IP>|room:<roomToken>")`,
  where `P2P_SPEEDTEST_NAMESPACE` is the fixed constant
  `7c522f7b-5c9f-5c64-8084-b4b10587c272` (itself
  `uuidv5(NAMESPACE_URL, "https://sws.aries0d0f.me/p2p-speedtest")`,
  computed once and hardcoded — never recomputed at runtime). This exact
  algorithm is the schema's canonical `peer-id` definition
  (`schemas/p2p-speedtest-result.v1.schema.yaml`) — not a placeholder.
- **Peer slot record**: the DO stores `{slot, peerId, ip, protocol}` for
  each connected peer at accept time — `ip` is the same
  `CF-Connecting-IP` used above, `protocol` is derived from its format
  (`IPv4`/`IPv6`). This is the **authoritative and only** source for
  `data.peers[].ip`/`protocol` in the result schema — it does not depend
  on the client-side geo lookup (decision 3/amendment #2) succeeding,
  since that lookup is explicitly allowed to fail and only ever supplies
  the optional `geo` sub-object.
- **Peer slot lifecycle & 3rd-join rule** (resolves the reject-vs-evict
  conflict from the first review pass): each connecting peer is assigned a
  slot (0 or 1) and a per-connection peer ID at WebSocket accept time. A
  slot is **live** as long as its socket is open and has responded to the
  DO's periodic heartbeat ping within a short timeout (e.g. 15s — this is
  a liveness check over the signaling socket itself, independent of the
  10-minute idle-room alarm below). A slot becomes **stale** the instant
  its socket fires `close`/`error`, or misses two consecutive heartbeats.
  A 3rd connection attempt is **rejected outright** if both slots are
  currently live. It is **allowed to replace** a slot only if that specific
  slot is stale — an active, responsive peer can never be evicted just
  because someone else has the room's join info.
- Room lifecycle: created on first WebSocket connect, destroyed/hibernated
  after both peer slots go stale/empty or an idle timeout (e.g. 10 minutes)
  — use DO alarms for that cleanup, not a cron.
- **Abuse mitigation for the reduced token entropy**: the Worker rate-limits
  room-lookup/join attempts per source IP (e.g. a handful per minute), so
  brute-forcing the 2^42 space is not practical within a room's ~10-minute
  lifetime. On the rare case a freshly generated token collides with an
  already-active room, the Worker regenerates and retries.
- No polling, no KV/D1 needed for the MVP — the token/slug/emoji key
  relationship is pure encoding/decoding, not a stored mapping.

### 2. NAT traversal: STUN + TURN in MVP, with relay disclosure

TURN is part of the MVP, not a stretch goal, but every result must make it
obvious to both users whether the test ran over a direct path or a relay.

- ICE server list includes public STUN plus a TURN server. Default choice:
  **Cloudflare Realtime/Calls TURN service**, since credentials can be
  minted server-side by the Worker without a third-party account — but the
  architecture must treat the TURN provider as swappable (a single Worker
  endpoint, e.g. `POST /api/room/:roomToken/ice-servers`, returns the
  `RTCIceServer[]` array; swapping to Twilio/Xirsys/Metered later is a
  provider-level change, not a redesign).
- Credentials are **short-lived** (minted per room, TTL just beyond the
  expected test duration, e.g. 5-10 minutes) and requested by each peer's
  browser only after it has a valid room token — never a static/global TURN
  secret shipped to the client.
- **Relay detection**: after the ICE connection reaches `connected`, both
  peers inspect `RTCPeerConnection.getStats()` for the currently selected
  candidate pair and read `localCandidateType` / `remoteCandidateType`. If
  either side is `relay`, the session is classified as **`RELAY`**;
  otherwise (`host`/`srflx` on both sides) it's **`DIRECT`**. These are
  two of the three values of the result schema's `data.via` field
  (`schemas/p2p-speedtest-result.v1.schema.yaml`) — the third, `UNKNOWN`, is
  the DO's fallback when the test never reached ICE classification at all
  (e.g. a pre-`paired` failure/cancellation), not a value either peer ever
  classifies locally. Each peer reports its own `DIRECT`/`RELAY`
  classification to the DO as part of its measurement report (data-model
  amendment below); the DO's canonical `via` is `RELAY` if any peer
  reported `RELAY`, `DIRECT` if at least one report arrived and none was
  `RELAY`, else `UNKNOWN`.
- **Disclosure mechanism**: the connection type (`DIRECT` | `RELAY`) is
  surfaced as a persistent, non-dismissable badge in the room UI the
  moment it's known locally (before the test even starts, from each
  peer's own `getStats()` read — not waiting on the DO round-trip), and is
  embedded as the `data.via` field on the finalized results object, shown
  again on the results screen and included in any copied/shared result
  text — so a relayed result can never be mistaken for a direct one, even
  out of context.
- If TURN itself is unreachable/fails, fall back to STUN-only behavior
  (connection may simply fail on hard NATs) — TURN is an enhancement to
  reachability, not a hard dependency of the signaling path.

### 3. Pairing & join methods: link/QR + Room ID + emoji key (copy-paste only)

Every room has its own temporary identity, exposed to users via **three
independent, equally valid** ways to join — no need to use more than one.

- On creation, the Worker generates one random **42-bit** room token
  (decision 1) and derives user-facing representations of it, all pure,
  reversible encodings of that same 42-bit value — no lookup table, no
  hashing, no truncation:
  - **Link + QR code**: `https://<host>/room/<slug>`, where `<slug>` is the
    42-bit token encoded as Crockford base32 (9 characters, zero-padded).
    The room page renders this link as a QR code for the creator to show
    the other person (e.g. scan on a phone, or across a video call).
  - **Room ID**: the same `<slug>` shown on its own (not just embedded in
    the link), for a peer to type into a plain "Join by Room ID" text input
    — this is the low-tech fallback that needs no camera, no clipboard, and
    no emoji rendering, just reading/typing a short alphanumeric code.
  - **7-character emoji join key**: the identical 42-bit token encoded
    against a small, curated emoji alphabet of exactly 64 entries
    (`64 = 2^6`, so each emoji carries exactly 6 bits and 7 of them exactly
    cover 42 bits — no wasted/ambiguous range), hand-picked for visual
    distinctiveness (no skin-tone/gender variants, no near-duplicate faces
    or symbols). This is a **copy-paste-only** affordance: a "copy" button
    next to the 7 emoji copies them to the clipboard for pasting into a
    chat/message to the other peer, who pastes it into the same join input
    as the Room ID. There is no on-screen emoji picker and no expectation
    anyone hand-types emoji — that UI was judged too complex for the value
    it added.
- **Join input**: a single text field on the join page accepts either a
  pasted Room ID or a pasted emoji key (detected by content, e.g. presence
  of emoji codepoints vs alnum) and resolves both to the same room lookup.
  A separate "paste link" path (or just navigating the link directly)
  covers the QR/link method.
- The room token itself stays internal (used only for `idFromName` and the
  WebSocket URL) — the slug/Room ID and emoji key are the only user-facing
  representations, all equally short-lived and disposable with the room.

### 4. Worker integration in this repo (React Router + Cloudflare Worker)

The current `workers/app.ts` unconditionally delegates every request to the
React Router SSR handler, and `wrangler.jsonc` has no Durable Object
binding or migration yet — both need explicit changes, not just "route
WebSockets in `workers/app.ts`":

- `workers/app.ts` must dispatch on the request **before** falling through
  to the React Router handler: if the path matches `/api/room/:roomToken`
  and the request carries an `Upgrade: websocket` header, forward it to the
  `SignalingRoom` Durable Object (`env.SIGNALING_ROOM.idFromName(roomToken)`
  → `.get(id).fetch(request)`); if the path matches `/api/room/:roomToken/
  ice-servers` (decision 2's TURN credential endpoint), handle it directly
  in the Worker (no DO needed just to mint credentials); everything else
  (including `/room/:slug` itself) falls through to the React Router
  handler unchanged so the app's normal routes keep rendering.
- `SignalingRoom` must be exported from the Worker entry module so Wrangler
  can bind it (Durable Object classes must be reachable from the file
  Wrangler treats as the Worker's main module).
- `wrangler.jsonc` needs a `durable_objects.bindings` entry (binding name
  e.g. `SIGNALING_ROOM`, `class_name: "SignalingRoom"`) plus a `migrations`
  entry (`new_sqlite_classes: ["SignalingRoom"]`, matching this project's
  `nodejs_compat`/SQLite-backed-DO era Wrangler defaults) so the class is
  actually provisioned.
- This is Phase 1 scope, not a later cleanup — the signaling backbone isn't
  demoable without it.

### 5. Measurement methodology

- Two logical channels per direction of testing:
  - A **reliable, ordered** control/ping data channel: small JSON/binary
    messages for handshake ("ready", "start-download", "start-upload",
    "phase-complete") and for latency measurement (ping/pong with
    timestamps → RTT, jitter from RTT variance).
  - One or more **unreliable, unordered** bulk data channels
    (`maxRetransmits: 0`) for the throughput test itself, to avoid TCP-like
    congestion/backpressure artifacts from a reliable channel distorting the
    bandwidth measurement.
- Throughput test shape: sender pushes fixed-size chunks (e.g. 16-64 KB)
  continuously for a fixed duration (e.g. 5-10s after a short ramp-up that's
  excluded from the calculation), respecting `bufferedAmountLowThreshold` /
  the `bufferedamountlow` event to avoid unbounded buffering. Receiver counts
  bytes received per time window; throughput = bytes / elapsed time.
- Download and upload are measured as two sequential phases with the sender
  role swapped between the peers (whoever is testing "download" is the
  receiver in that phase). Duplex/simultaneous measurement is out of scope
  for MVP (adds complexity in attributing available bandwidth per direction
  on asymmetric links) — may be revisited later.
- **Result shape** (data-model amendment below): the two phases' measured
  throughput are not stored as "download"/"upload" — they're stored as two
  directional `bandwidth` edges keyed by `peer-id` (`{from, to, speed,
  latency, jitter}`, per `schemas/p2p-speedtest-result.v1.schema.yaml`),
  since the schema models bandwidth as a peer-to-peer graph, not a
  session-relative label. `speed` is in bits per second (not Mbps) in the
  stored record; UI layers convert for display.
- Packet loss can be derived cheaply from the unreliable channel (sequence
  numbers in each chunk) as a bonus metric, not a required one.

### 6. Pages / routes

The app has exactly three top-level pages. Each owns a distinct
responsibility — the home page never runs signaling/WebRTC code, the room
page never renders the results *list*, and the results page never talks to
a Durable Object. This split keeps the room page (the most stateful, most
failure-prone part of the app) free of unrelated concerns.

- **Home page — `/` (branding + entry point)**
  - A marketing/branding page, not a dashboard. Top-to-bottom sections:
    1. **Hero / main action**: the app's name and a one-line pitch, plus the
       two entry actions side by side — "Create a test" (generates a room
       and navigates to `/room/:slug`) and "Join a test" (a single input
       accepting a pasted link, typed Room ID, or pasted emoji key, per
       decision 3, that resolves to the same `/room/:slug`).
    2. **How it works**: a short, static explainer of the mechanism —
       peer-to-peer via WebRTC, Cloudflare only relays signaling (and TURN
       traffic in the disclosed relayed case), no accounts, nothing
       uploaded to a server. Purely informational, no app state.
    3. **Credits**: attribution (project author, key libraries/services
       used — e.g. Cloudflare Workers/Durable Objects, WebRTC).
    4. **Footer**: links (e.g. source repo, results history page, license).
  - No connection/session state lives on this page. It only creates or
    resolves a room token and navigates away.
- **Room page — `/room/:slug` (all speedtest logic lives here)**
  - Owns the entire session lifecycle as a single state machine, one state
    at a time, both peers seeing equivalent (not necessarily identical —
    e.g. "waiting for peer" only makes sense for the first arrival) UI for
    each state:
    - `waiting` — first peer has created/entered the room, room's join
      methods (QR/link, Room ID, emoji key) are displayed, waiting for the
      second peer's signaling connection (decision 1).
    - `pairing` — second peer has connected over the signaling WebSocket;
      SDP/ICE exchange and `RTCPeerConnection` establishment in progress
      (decision 2); each peer also performs its client-side geo self-lookup
      here (data-model amendment below) and reports `{ip, protocol, geo}`
      to the DO, in parallel with connection establishment.
    - `paired` — ICE connected; the direct-vs-relayed badge (decision 2) is
      now known and shown; both peers see a "ready to test" state (possibly
      with a manual or auto-start trigger — exact trigger is a Phase 2/3
      implementation detail, not fixed here).
    - `testing` — latency (Phase 3) then throughput download/upload
      (Phase 4) phases run in sequence, with live numbers shown to both
      peers as they're measured.
    - `finalizing` — brief sub-state after both throughput phases complete
      (or after a failure/cancellation): each peer sends its measurement
      report to the DO and waits for the DO's `result-ready` message
      (data-model amendment below) carrying the canonical, hash-signed
      result. This is normally sub-second; a timeout here without a
      `result-ready` response falls into the same error sub-state pattern
      as other `testing` failures.
    - `result` — the finalized record (from `finalizing`) is shown in-place
      on the room page, *and* each peer writes its own `metadata`-wrapped
      copy to `localStorage` (decision 7) so it also shows up later on the
      results page. The room page's result view is the "just finished,
      both peers looking at it together" view; the results page (below) is
      the durable history. This state is reached for all three `status`
      values (`SUCCESSED`/`FAILED`/`CANCELED`), not success only.
  - Connection-state errors (peer disconnected mid-test, ICE/TURN failure)
    are handled as sub-states of `pairing`/`testing`, not separate routes;
    they transition through `finalizing` into `result` with
    `status: FAILED` or `CANCELED` rather than being a dead end.
- **Results page — `/results` (local history, detail view, import/export)**
  - Reads exclusively from `localStorage` (decision 7) — no network calls,
    no room/DO interaction. Works standalone even if no test was ever run
    in this browser (empty state).
  - **List view** (default): every stored result as a row/card —
    `data.timestamp`, bandwidth summary derived from `data.bandwidth`,
    `data.via` (`DIRECT`/`RELAY`) badge, `data.status`
    (`SUCCESSED`/`FAILED`/`CANCELED`) indicator. Sorted newest first.
  - **Detail view**: selecting an entry (`/results/:room/:peerId` — see
    decision 7's amendment; there is no locally-generated id) shows its
    full record — same fields as the room page's post-test summary, so
    nothing is lost by navigating away from the room page.
  - **Import/export**: an "Export" action serializes the stored results
    (all, or a selection) to a downloadable JSON file; an "Import" action
    reads a previously-exported JSON file and merges its entries into
    `localStorage` (decision 7 defines the exact merge/dedup rule). This is
    the only way results move between browsers/devices, since there is no
    server-side storage.
- Global nav: a persistent, lightweight way to reach the results page from
  the home page (e.g. a footer link) and from the room page after a result
  lands (e.g. a "View history" link alongside the in-place result). No
  header/nav chrome is assumed beyond what each page's own layout needs.

### 7. Local results persistence & import/export

**Superseded 2026-07-29 by the data-model amendment below** — the record
shape is no longer defined inline here. The canonical, machine-validated
definition lives in `schemas/p2p-speedtest-result.v1.schema.yaml`
(`kind: P2PSpeedtestResult`, `apiVersion: sws.aries0d0f.me/v1`), with a
worked example in `schemas/p2p-speedtest-result.example.yaml`. This
section now only covers the storage/write/import mechanics around that
schema, which are unchanged in spirit from the original decision.

- **Storage**: results are stored in the browser's `localStorage` under a
  single namespaced key (e.g. `p2p-speedtest:results`) as a JSON array of
  `P2PSpeedtestResult` records (the full envelope — `apiVersion`, `kind`,
  `metadata`, `data` — not just the `data` payload). `localStorage` (not
  `IndexedDB`) is sufficient given the expected record count and size —
  revisit only if real usage shows otherwise.
- **Record shape**: exactly `schemas/p2p-speedtest-result.v1.schema.yaml`.
  Notably:
  - `metadata.id` is the room ID (dup of `data.room`); `metadata.peer-id`
    is *this browser's* peer id (differs between the two peers' stored
    copies of the same test); `metadata.hash` is the DO-computed integrity
    hash over `data` (see "Amendment (2026-07-29, #2)" below) — both
    peers' `metadata.hash` values are identical since `data` itself is
    identical.
  - `data.status` is one of `SUCCESSED | FAILED | CANCELED` — all three
    are persisted (not success-only); `data.peers`/`data.bandwidth` may
    have fewer than 2 entries for non-`SUCCESSED` records, per the
    schema's conditional length rule.
  - There is no separate `schemaVersion` field — `apiVersion` fills that
    role (a future breaking change ships as `sws.aries0d0f.me/v2`, and
    readers branch on it the same way a `schemaVersion` bump would have
    been handled).
- **Write path**: each peer writes exactly one `P2PSpeedtestResult` record
  per finalized (completed, failed, or canceled) test, at the moment the
  `result` state (decision 6) is reached, using the DO-finalized `data` +
  `metadata.hash` it received from `result-ready` — never assembled or
  hashed client-side. **If the DO never finalizes** (crash, signaling drop
  before `result-ready`), **no record is written** — there is no
  locally-synthesized fallback; the room page shows a non-persisted error
  state instead (Phase 4 scope). Written once, never mutated afterward,
  guarded against duplicate writes from re-renders/reconnects
  (implementation detail, not fixed here — the relevant phase plan owns
  it).
- **Import merge rule**: importing a JSON export merges by
  `metadata.peer-id` + `data.room` (the combination that's actually unique
  per stored record, since two peers' records for the same test share
  `data.room` but differ in `metadata.peer-id`) — entries that already
  exist locally under that combination are skipped (first-write-wins;
  imports never overwrite existing local history), everything else is
  appended. Malformed entries (failing schema validation, including
  `apiVersion`/`kind` mismatches, **or a `metadata.hash` that doesn't
  match a recomputed hash over the entry's own `data`**) are skipped
  individually with a visible warning, not a fatal import error for the
  whole file. Hash recomputation uses the same canonical-serialization
  algorithm the DO uses to compute it in the first place
  (`app/lib/result-hash.ts`, shared code) — this is what makes the hash a
  real integrity check on import, not just a schema-shaped field.
- **Results detail route**: `/results/:room/:peerId` (decision 6,
  amendment #2 point 4) — not `/results/:id`, since there is no locally
  generated id.
- **Export format**: the exported JSON is exactly `{ results: [...] }`
  where each entry is a full `P2PSpeedtestResult` envelope (no separate
  top-level `schemaVersion` wrapper, since each record already carries its
  own `apiVersion`) — the same shape read back on import — so
  export-then-import round-trips losslessly and files are portable
  between browsers.
- No size cap is enforced in the MVP beyond `localStorage`'s own browser
  quota; if that becomes a real constraint, a follow-up can add a
  max-entries eviction policy (oldest-first).

## Phase Breakdown

Each phase below becomes its own implementation plan
(`.claude/plan/<phase-slug>.md`) once we're ready to start it. Phases are
ordered so the app is left in a working, demoable state after each one.

### Phase 1 — Signaling backbone + pairing
`SignalingRoom` Durable Object (exported, bound, and migrated per decision
4), `workers/app.ts` request dispatch (`/api/room/:roomToken` WebSocket
upgrade → DO, `/api/room/:roomToken/ice-servers` → Worker, everything else
→ React Router), 42-bit room token generation with collision retry and
per-IP rate limiting, the slug/Room ID and 7-emoji encodings of that token,
the peer-slot/heartbeat/stale-eviction rule from decision 1, message relay,
idle cleanup via alarm. Home page can create a room and show all three join
methods (QR/link, Room ID, copy-paste emoji key); join page's single input
resolves any of them back to the same room. No WebRTC yet — verify with a
raw WebSocket echo test between two tabs joined via each method, plus a
manual test of the stale-eviction rule (kill one tab's network without a
clean close, confirm a 3rd tab can take over only after the heartbeat
timeout, not before).

### Phase 2 — WebRTC connection establishment (STUN + TURN)
Frontend `RTCPeerConnection` setup, offer/answer + ICE exchange over the
Phase 1 signaling channel, ICE server config combining STUN with
short-lived TURN credentials minted by the Worker, connection-state UI
(waiting / connecting / connected / failed). Includes the relay-detection
logic (`getStats()` candidate-pair inspection) and the direct-vs-relayed
badge. Success = two tabs show "connected" with an accurate connection-type
badge, and can exchange a manual test message over a data channel, in both
a direct-path test and a forced-relay test (e.g. via `iceTransportPolicy:
"relay"` in dev) to confirm detection works both ways.

### Phase 3 — Latency measurement
Reliable ping/pong data channel, RTT + jitter calculation, live display.
Smallest possible measurement feature to validate the data-channel-based
metrics approach before tackling throughput.

### Phase 4 — Throughput measurement (download + upload) + result persistence
Unreliable bulk data channel(s), chunked send loop with backpressure
handling, phase sequencing (download then upload, roles swapped per the
canonical slot mapping), live Mbps display. Each peer reports its own
measured edge, latency, and `via` classification to the DO; the DO
finalizes and hash-signs the canonical `P2PSpeedtestResult.data`
(`schemas/p2p-speedtest-result.v1.schema.yaml`, amendment #2) and relays it
back to both peers via the room page's `finalizing` → `result` states
(decision 6). Each peer writes its own `metadata`-wrapped copy of that
identical `data`/`hash` to `localStorage` — this is the point the results
page (Phase 5) starts having data to show. Covers all three `data.status`
outcomes (`SUCCESSED`/`FAILED`/`CANCELED`), not success-only.

### Phase 5 — Results page, polish & robustness
Build the `/results` page (decision 6): list view, detail view, and the
import/export mechanism (decision 7, incl. the merge-by-`metadata.peer-id`
+`data.room` rule and per-entry `apiVersion` validation against the
schema). Also: room expiry/cleanup edge cases, reconnect/error handling
(peer closes tab mid-test, ICE/TURN failure messaging — routed through
`finalizing` into a `FAILED` result, not a dead end), QR code and
copy-to-clipboard UI refinement, responsive layout across all three pages,
basic result sharing from both the room page and results page (copy
results text/link, including `data.via` in the copied output).

### Phase 6 — Stretch: beyond MVP
Ideas explicitly out of scope for Phases 1-5, to revisit afterward:
duplex (simultaneous) throughput measurement, mobile browser support,
swapping/adding TURN providers beyond the default, a max-entries eviction
policy for `localStorage` if quota becomes a real constraint.

## Risks & Mitigations

- **Risk**: A relayed (TURN) test measures throughput to Cloudflare's edge
  and back, not truly direct P2P bandwidth — if disclosure is missed or
  easy to ignore, users could misread a relayed result as their real direct
  link speed.
  - Mitigation: connection type is a persistent, non-dismissable badge and
    a first-class field on the results object itself (not just a one-time
    toast), so it survives into copied/shared results.
  - Followup: revisit whether relayed results should even be labeled
    "speedtest" results at all vs. a separate "connectivity check" framing.
- **Risk**: TURN relay bandwidth has a real cost and is a shared resource;
  a public tool could be abused to run large sustained transfers through
  the relay.
  - Mitigation: short-lived, per-room TURN credentials (decision 2); cap
    test duration/data volume server-side regardless of client behavior;
    revisit rate-limiting per IP if abuse is observed after launch.
- **Risk**: Durable Object WebSocket hibernation/cleanup edge cases (peer
  refreshes, closes tab, network drop without a clean close) leaving rooms
  in a stuck state, or conversely letting a 3rd party bump an active peer.
  - Mitigation: the heartbeat-based stale/live rule in decision 1 is the
    single source of truth — a slot is only evictable once it's actually
    stale (closed or missed heartbeats), never just because a 3rd party has
    the join info; DO alarms handle the separate case of the whole room
    going idle.
- **Risk**: The room token's reduced 42-bit entropy (needed to fit the
  7-emoji key) is guessable given enough attempts, if left unthrottled.
  - Mitigation: per-IP rate limiting on room lookup/join (decision 1);
    short room lifetime (~10 min) bounds the attack window regardless.
- **Risk**: Reliable-channel congestion control interfering with throughput
  measurement accuracy if we're not careful about channel config.
  - Mitigation: Bulk transfer channels must be created with
    `ordered: false, maxRetransmits: 0`; verified explicitly in Phase 4.
- **Risk**: Browser differences in `RTCDataChannel` buffering/back-pressure
  behavior (Safari vs Chrome vs Firefox) skewing results.
  - Mitigation: Cross-browser manual test pass at the end of Phase 4, before
    Phase 5 polish.
- **Risk**: Results only live in one browser's `localStorage` — clearing
  site data, using a different browser/device, or private/incognito mode
  loses history with no server-side backup.
  - Mitigation: this is accepted as inherent to the "no accounts, no
    server-side persistence" requirement; the export/import mechanism
    (decision 7) is the intended way to move or back up history, not a
    substitute for server storage.
- **Risk**: A hand-authored or corrupted import file could break the
  results page if parsed without validation.
  - Mitigation: decision 7's import path validates each entry against the
    result schema individually and skips malformed ones with a visible
    warning, rather than failing the whole import or rendering broken data.

## Success Criteria (for the MVP, Phases 1-5)

- [ ] A room can be joined via **any of** the shared link/QR code, a typed
      Room ID, or a copy-pasted 7-emoji join key, all resolving to the same
      room.
- [ ] Two browsers on different networks can establish a WebRTC connection,
      falling back to TURN relay when a direct path isn't available.
- [ ] The connection-type badge (`DIRECT` vs `RELAY`) is accurate and
      visible before and after the test, and appears as `data.via` in the
      results data/summary.
- [ ] Latency (RTT) is measured and displayed live.
- [ ] Bandwidth is measured in both directions and displayed, with a final
      results summary visible to both peers, sourced from the DO's
      `result-ready` payload and identical (same `hash`) across both
      peers' stored copies.
- [ ] Room state is cleaned up (DO alarm) after peers disconnect or go idle;
      a stale peer slot can be replaced by a 3rd joiner, but a live peer
      never gets evicted just because someone else has the join info.
- [ ] The home page (`/`), room page (`/room/:slug`), and results page
      (`/results`, `/results/:room/:peerId`) exist as the three top-level routes per
      decision 6, each scoped to its own responsibility.
- [ ] Completed, failed, and canceled tests are all written to
      `localStorage` as `P2PSpeedtestResult` records validating against
      `schemas/p2p-speedtest-result.v1.schema.yaml`, and are visible on the
      results page's list and detail views.
- [ ] Results can be exported to a JSON file and re-imported (including
      into a different/empty browser storage) without data loss or
      duplication, per the decision 7 merge rule (`metadata.peer-id` +
      `data.room`).
- [ ] `SignalingRoom` is exported, bound, and migrated in `wrangler.jsonc`;
      `/api/room/*` requests are dispatched correctly alongside normal
      React Router routes (`/room/:slug` still renders the app).
- [ ] `bun run typecheck` and `bun run build` pass.
- [ ] Manual cross-browser check (Chrome, Firefox, Safari) completed,
      including at least one forced-relay run per browser.

## Implementation Order

Phases 1 → 2 → 3 → 4 → 5 are strictly sequential (each depends on the prior
phase's working state) and together make up the MVP. Phase 6 is explicitly
out of MVP scope and can be picked up in any order afterward.

## Review Feedback (Codex, 2026-07-29)

### Review State
- **Status: RESOLVED** — see resolutions below; addressed in decisions 1, 3,
  and the new decision 4 (Worker integration).

### Findings
- **[P1] The 7-emoji join key cannot be a reversible pure-function encoding of the same 128-bit room token.** The plan requires one internal unguessable token and says the link slug, Room ID, and 7-character emoji key are all pure functions of that same token, with decoding any of them resolving to the same room. But a 7-character key over a 64-entry alphabet carries about 42 bits (`64^7`), so it cannot encode or recover a 128-bit token without collisions. If the emoji key is a truncated/hash-derived alias, Phase 1 needs a lookup/index store to map it back to the room token, which contradicts the current "no KV/D1 needed" and pure-function claims. If the emoji key itself becomes the room identity, the current "128-bit random value" and unguessability assumptions need to be revised. Add one explicit design: lengthen the emoji code enough to encode the token, reduce/redefine the room-token entropy with collision handling and abuse limits, or introduce a short-lived alias mapping with a concrete Worker/DO/KV ownership model.
  - **Resolved**: room token reduced to 42 bits (exactly `64^7`), so the
    slug/Room ID and emoji key are true bijective encodings of one value —
    no lookup table. Reduced entropy is offset by per-IP rate limiting and
    the room's short (~10 min) lifetime. See decision 1 and decision 3.
- **[P2] Third-join behavior conflicts between the architecture decision and the mitigation.** Decision 1 says the Durable Object rejects a 3rd joiner, while the cleanup risk mitigation says to always allow a 3rd connection attempt to evict a stale/disconnected socket rather than hard-rejecting. That difference matters for the signaling state machine and for user safety: an active peer should not be evicted just because someone else has the room link. Define the exact rule for stale socket detection, whether existing peers are authenticated by per-peer IDs, and when a 3rd connection is rejected vs allowed to replace a stale connection.
  - **Resolved**: explicit peer-slot/heartbeat rule added to decision 1 — a
    3rd join is rejected if both slots are live, allowed to replace only a
    slot that's demonstrably stale (closed or missed heartbeats). The
    conflicting risk-mitigation wording was corrected to match.
- **[P2] The Worker integration path is underspecified for this React Router + Cloudflare Worker repo.** The plan mentions routing WebSockets in `workers/app.ts`, but the current Worker entrypoint delegates all requests to the React Router handler and `wrangler.jsonc` has no Durable Object binding or migration. The phase plans need explicit tasks for API route dispatch before the React Router handler, exporting the `SignalingRoom` Durable Object class, adding the `durable_objects` binding and migration, and ensuring React Router app routes like `/room/:slug` still render normally while `/api/room/:roomToken` upgrades to WebSocket.
  - **Resolved**: new decision 4 specifies `workers/app.ts` dispatch order,
    exporting `SignalingRoom`, and the required `wrangler.jsonc`
    `durable_objects`/`migrations` entries, called out as Phase 1 scope.

### Required Updates
1. Resolve the room identity encoding design so every join method can deterministically and safely resolve to one room without impossible bit-packing or undocumented storage.
2. Reconcile the 2-peer cap with stale peer replacement by specifying the Durable Object socket lifecycle and 3rd-join rules.
3. Add repo-specific Worker integration constraints to the main plan so Phase 1 implementation plans include Durable Object config, routing, and migration work.

## Re-Review Feedback (Codex, 2026-07-29)

### Review State
- **Status: APPROVED**

### Assessment
- **P1**: Resolved. The plan no longer claims a 7-emoji key can encode a 128-bit token. It now deliberately uses a 42-bit room token, makes the Room ID and emoji key bijective encodings of that same value, and records the reduced-entropy tradeoff plus collision retry and abuse mitigation.
- **P2**: Resolved. The 3rd-join behavior now has a single rule: live peer slots are protected, stale slots can be replaced, and stale detection is tied to socket close/error or missed heartbeats.
- **P2**: Resolved. The React Router + Cloudflare Worker integration path is now explicit: API dispatch happens before the React Router handler, `SignalingRoom` must be exported, and `wrangler.jsonc` must add the Durable Object binding and migration.

### Follow-Up For Claude (Phase 1 Plan)
1. Specify the concrete rate-limiting mechanism for room lookup/join attempts, since the main plan relies on throttling to make the 42-bit room-token choice acceptable.

## Amendment (2026-07-29): Page/route definitions

Added decision 6 (Pages / routes) defining the three top-level pages —
home (`/`, branding + create/join), room (`/room/:slug`, all speedtest
logic and its `waiting → pairing → paired → testing → result` states), and
results (`/results`, `/results/:room/:peerId`, local history + detail + import/
export) — and decision 7 (local results persistence & import/export)
specifying the `localStorage` schema, write path, and import merge rule.
This elevates what was previously listed under Phase 6 as a stretch goal
("local results history") into MVP scope: Phase 4 now includes writing the
result record on test completion, and Phase 5 now includes building the
results page itself. Requirements, Phase Breakdown, Risks, and Success
Criteria were updated to match. Architecture decisions 1-5 (signaling,
NAT traversal, pairing, Worker integration, measurement methodology) are
unaffected. This amendment has not yet been through a Codex re-review pass.

## Re-Review Feedback (Codex, 2026-07-29, amendment)

### Review State
- **Status: APPROVED**

### Assessment
- **Amendment scope**: Approved. Moving local results history into MVP is consistent with the no-accounts/no-server-persistence constraint because the storage boundary is explicitly browser `localStorage`, with import/export as the portability path.
- **End-to-end flow**: Approved. The plan now connects the room page's completed `result` state to the persisted result schema, then to `/results` list/detail views and import/export, so the added feature has a complete delivery path across model, UI, and browser storage.
- **Prior findings**: Still resolved. The amendment does not reopen the 42-bit join key design, stale peer replacement rules, or Worker/Durable Object integration requirements.

### Follow-Up For Claude (Phase 5 Plan)
1. Specify that `/results` and `/results/:id` read `localStorage` only on the client side, with an SSR-safe initial/empty state, because this React Router app can render routes server-side where `window.localStorage` is unavailable.
2. Clarify result sharing semantics for local-only history: copied result text is portable, but any copied `/results/:id` link only resolves in browsers that already have that result in `localStorage` unless the JSON export/import path has been used.

## Amendment (2026-07-29, #2): Server-finalized, hash-signed result schema

The user supplied a concrete data model/API spec for the speedtest result
as a YAML example. It is now the canonical source of truth for the result
record, replacing decision 7's inline flat schema. Canonical files:

- `schemas/p2p-speedtest-result.v1.schema.yaml` — JSON Schema (draft 2020-12)
  for the full `P2PSpeedtestResult` envelope.
- `schemas/p2p-speedtest-result.example.yaml` — a schema-valid worked
  example (the user's pasted example had YAML syntax errors — mixed
  tabs/spaces, misaligned nesting — corrected here without changing any
  field name, value convention, or the `SUCCESSED` spelling).

This is a structural change, not just a rename. Three points were decided
in chat (2026-07-29) and are now load-bearing:

1. **The result is finalized server-side, not peer-computed — and ONLY
   the DO ever produces a persistable record.** Each peer reports its own
   local measurements (throughput it received, its own latency/jitter
   finalization from Phase 3, its own `via` classification) to the
   `SignalingRoom` DO over the existing signaling WebSocket — note
   `ip`/`protocol` are **not** part of this report (see point 2, revised).
   Once the DO has both peers' reports (or a failure/cancellation/timeout
   condition), it assembles the canonical `data` object — using its own
   accept-time-recorded `{peerId, ip, protocol}` per peer (decision 1) plus
   whatever `geo` each peer separately reported — validates the
   application-level invariants a JSON Schema can't express (`data.room`
   matches the room; `bandwidth[].from`/`to` each reference a known
   `peers[].id`; when two bandwidth entries exist they're a reverse pair),
   computes `hash` (SHA-256 hex over a canonical/stable-key JSON
   serialization of `data` — see `app/lib/result-hash.ts`, a module shared
   between the DO and the client so both sides use the identical
   algorithm), and sends a `result-ready` message containing `{data, hash}`
   back to both peers. Each peer then wraps that identical `(data, hash)`
   pair in its own `metadata` (`id`, its own `peer-id`, `hash`) and writes
   the record to `localStorage`.
   **If `result-ready` never arrives** (DO crash, signaling drop before
   finalization) — **no record is persisted at all.** There is no
   locally-synthesized fallback record with a placeholder hash (an earlier
   draft of this amendment proposed one; Codex correctly flagged that it
   would contradict "DO-only hash" and undermine import-time integrity
   checks). The room page instead shows a non-persisted "couldn't finalize
   the result" error state (Phase 4 scope), with a retry/dismiss action —
   losing an occasional record to a rare DO/signaling failure is
   preferable to ever writing a record whose `hash` doesn't actually
   attest to DO involvement.
   The DO does not persist `data`/`hash` beyond the relay — it computes
   and forwards, then the room's normal idle-alarm cleanup (decision 1)
   still applies. This does **not** violate the "no server-side
   persistence" requirement: the DO never writes the result anywhere
   durable, it's a compute-and-relay step over data that already left the
   peers' hands as small JSON messages (not test traffic, which still
   never touches Cloudflare's network in the direct case).
2. **Geo lookup is client-side and best-effort; `ip`/`protocol` are
   always server-observed, never client-reported (resolves Codex's
   schema-amendment P1 finding).** During `pairing`, each peer's browser
   calls `https://ip.aries0d0f.me/?q=geo` (an HTTPS/CORS-safe proxy the
   user runs in front of ip-api.com — chosen specifically to work around
   ip-api.com's free tier being HTTP-only and lacking CORS headers, both
   blockers for a browser-side fetch from an HTTPS page) to look up its
   own geolocation, then reports **only** `{geo}` to the DO (not
   `ip`/`protocol` — an earlier draft of this amendment had the client
   report those too, which Codex correctly flagged as a single point of
   failure: if the geo proxy is unreachable, the DO would have no
   schema-required `ip`/`protocol` for that peer). `ip`/`protocol` are
   populated by the DO exclusively from its own accept-time
   `CF-Connecting-IP` record (decision 1's "Peer slot record") — this
   never depends on the geo proxy succeeding. A failed geo lookup means
   that peer's `data.peers[].geo` is `{}`, nothing else changes. This geo
   step runs in parallel with ICE negotiation in the `pairing` state
   (decision 6), not blocking it.
3. **All three `status` values (`SUCCESSED`, `FAILED`, `CANCELED`) are
   persisted**, not success-only — but only once the DO actually
   finalizes one (per the revised point 1: a DO/signaling failure that
   prevents finalization produces no record, not a `FAILED` one; a
   `FAILED`/`CANCELED` `status` means the DO *did* finalize, just with an
   unsuccessful outcome, e.g. a peer disconnected mid-test or the test was
   explicitly canceled). A room page's `finalizing`/`result` states
   (decision 6) are reached on failure and cancellation too, not just
   successful completion. Because a failed/canceled test may never reach
   a second peer or ever measure anything, the schema's `peers`/
   `bandwidth` arrays only require exactly 2 items when
   `status === SUCCESSED`; otherwise they may be shorter. Similarly,
   `data.via` is `UNKNOWN` (a third enum value added in response to
   Codex's schema-amendment P1 finding) when the test never reached ICE
   classification — only `SUCCESSED` records are guaranteed a non-UNKNOWN
   `via` (see the schema file's `if`/`then` block).

4. **Results detail route key** (resolves Codex's Phase 2/5
   schema-amendment findings): since a stored record's identity is
   `metadata.peer-id` + `data.room`, not a locally-generated id, the
   results detail route is `/results/:room/:peerId` (both segments are
   URL-path-safe: `room` is the 9-char slug, `peerId` is a standard UUID).
   `/results/:id` (singular) is retired from decision 6's route list.

### Cross-decision impact summary

- **Decision 1** (signaling): DO gains peer-id assignment (server-observed
  IP, exact UUIDv5 algorithm now fixed above), an accept-time
  `{peerId, ip, protocol}` peer-slot record (the sole source of
  `data.peers[].ip`/`protocol`), and post-test report/finalize/validate/
  hash/relay responsibility. Still one DO instance per room, still no
  KV/D1, still alarm-based cleanup. A finalization that never completes
  produces no record (not a fallback one).
- **Decision 2** (NAT traversal): `direct`/`relayed` renamed to
  `DIRECT`/`RELAY`/`UNKNOWN` to match `data.via` exactly; classification
  logic unchanged for the two known cases, `UNKNOWN` covers pre-ICE
  failure/cancellation; the DO needs each reporting peer's classification
  to produce one canonical `via`, and uses `UNKNOWN` when no peer ever
  reported one.
- **Decision 3** (pairing): geo lookup (client-side, during `pairing`)
  supplies only the optional `geo` sub-object; it never supplies
  `ip`/`protocol`, which come exclusively from decision 1's DO-side
  peer-slot record.
- **Decision 5** (measurement methodology): the "download"/"upload" mental
  model for running the test is unchanged (two sequential phases, roles
  swapped), but the *stored* result reframes that as two directional
  `bandwidth` edges keyed by `peer-id`, matching a peer-to-peer graph
  rather than a session-relative label. Stored `speed` is bits per second,
  not Mbps.
- **Decision 6** (pages/routes): room page state machine gains a
  `finalizing` sub-state between `testing` and `result`, and `result` is
  now reachable for all three statuses, not success-only (but only once
  the DO actually finalizes — see point 1's revision). Results detail
  route is `/results/:room/:peerId`, not `/results/:id`.
- **Decision 7** (persistence): rewritten above to point at the schema
  files; write path now consumes the DO's `result-ready` payload instead
  of assembling the record purely client-side (with no local fallback on
  timeout); import/export and merge rules updated to the new envelope
  shape; import now also recomputes and verifies `metadata.hash` against
  `data` (via the shared `app/lib/result-hash.ts`), not just structural
  schema validation.

### Impact on existing phase plans

`.agents/plan/phase-1-signaling-backbone.md` through
`phase-5-results-polish.md` were originally written against the old flat
decision-7 schema and the peer-computed/idempotent-write design from the
prior Codex review round. They have now been re-synced to this amendment
in their schema-amendment revision notes. Historical review sections below
remain for traceability, but the current phase instructions should follow
this amendment and the updated phase-plan sections that reference
`schemas/p2p-speedtest-result.v1.schema.yaml`.

## Review Feedback (Codex, 2026-07-29, schema amendment)

### Review State
- **Status: CHANGES REQUESTED**

### Findings
- **[P1] `data.via` is required for `FAILED`/`CANCELED` records even though the amendment says those records may happen before ICE classification exists.** The schema requires `data.via` for every result, and the main success criteria require failed/canceled tests to validate against that schema. But the amendment also says a failed/canceled test may never reach a second peer or ever measure anything. In those cases there may be no selected ICE candidate pair and no meaningful `DIRECT`/`RELAY` value. This blocks implementation because the DO cannot produce a truthful schema-valid record for early failure/cancel paths. Either add an `UNKNOWN`/`UNDETERMINED` enum value, make `via` conditionally required only after pairing/ICE classification exists, or scope persisted failed/canceled records to only failures after `via` is known.
- **[P1] Required peer `ip`/`protocol` fields are sourced from a client-side geo lookup that can fail.** The amendment says each peer reports `{ip, protocol, geo}` after calling the geo proxy, while the schema requires `peers[].ip` and `peers[].protocol` whenever a peer is included. Phase 2 says geo lookup failure should not block the test, but the main does not define a server-observed fallback for `ip`/`protocol` in `data.peers`. Without that fallback, any failure of `https://ip.aries0d0f.me/?q=geo` leaves the DO unable to include that peer in a schema-valid result. Define that the DO stores authoritative `ip`/`protocol` from `CF-Connecting-IP` at WebSocket accept and uses client geo lookup only to populate the optional `geo` fields.
- **[P2] The hash/signing contract is internally inconsistent around fallback records.** Decision 7 says records use the DO-finalized `data` plus DO-computed `metadata.hash`, never hashed client-side. Phase 4 now proposes a locally synthesized failed record with a placeholder zero hash if `result-ready` never arrives. That would still match the schema pattern but violates the main contract and undermines import-time integrity checks. Decide whether non-DO fallback records are out-of-scope for persistence, get a real client-computed integrity hash with an explicit `source`/attestation field, or require all persisted records to come from DO finalization only.

### Required Updates
1. Fix the schema/main contract for `data.via` on pre-ICE `FAILED`/`CANCELED` records.
2. Make server-observed `ip`/`protocol` the fallback or authority for `data.peers[]`, with client geo lookup supplying optional geo details only.
3. Remove or redesign local placeholder-hash fallback records so persisted records do not look DO-finalized when they are not.

### Resolution (2026-07-29)
1. **Resolved**: schema's `data.via` gained a third enum value, `UNKNOWN`,
   required always but only `SUCCESSED` records are constrained to a
   non-`UNKNOWN` value (`if`/`then` block). Amendment point 3 updated to
   match.
2. **Resolved**: amendment point 2 rewritten — the client's `geo-report`
   now carries only `{geo}`; `ip`/`protocol` come exclusively from the
   DO's accept-time `CF-Connecting-IP` record (decision 1's new "Peer slot
   record" bullet), never from the client. Schema's `peer` def and
   top-level description updated to state this explicitly.
3. **Resolved**: the local placeholder-hash fallback is removed entirely.
   Amendment point 1 now states plainly that a finalization the DO never
   completes produces no persisted record at all — the room page shows a
   non-persisted error state instead. `metadata.hash` is therefore always
   a real DO-computed value when a record exists. Also added: a canonical
   hash algorithm (`app/lib/result-hash.ts`, shared between DO and
   client) and a requirement that import re-verifies the hash, not just
   the schema shape (decision 7, cross-decision impact summary).

Also fixed, beyond the three findings above, since they surfaced while
resolving them: the `peer-id` UUIDv5 algorithm is now fully concrete (a
hardcoded namespace constant + exact name-string format, decision 1),
replacing the earlier "exact concatenation format to be fixed later"
placeholder Codex separately flagged in Phase 1's schema-amendment review;
and the results detail route key (`/results/:room/:peerId`) is now settled
(new amendment point 4), resolving Phase 2/5's coordination finding.

## Re-Review Feedback (Codex, 2026-07-29, schema amendment)

### Review State
- **Status: APPROVED**

### Assessment
- **P1**: Resolved. `data.via` now supports `UNKNOWN`, with schema logic requiring non-`UNKNOWN` only for `SUCCESSED` records, so early failed/canceled finalization has a truthful schema-valid value.
- **P1**: Resolved. Peer `ip`/`protocol` are now authoritative DO-observed fields captured from `CF-Connecting-IP`; client geo lookup supplies only optional `geo`.
- **P2**: Resolved. Placeholder local fallback records are removed. Persisted records now only come from DO `result-ready`, and import is required to recompute/verify the shared canonical hash.

### Follow-Up For Implementation
1. Keep `app/lib/result-hash.ts` shared by Worker and browser code; do not fork the canonicalization implementation.
