# Master Plan: P2P Speedtest (WebRTC + Cloudflare Workers)

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
- The DO's only job: track up to 2 connected peer slots per room (see the
  explicit join/eviction rule below), relay messages between them verbatim
  (SDP offer, SDP answer, ICE candidates, and later a "ready"/"start test"
  handshake), and enforce that cap.
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
  either side is `relay`, the session is classified as **relayed**;
  otherwise (`host`/`srflx` on both sides) it's **direct**.
- **Disclosure mechanism**: the connection-type (`direct` | `relayed`) is
  surfaced as a persistent, non-dismissable badge in the room UI the moment
  it's known (before the test even starts), and is embedded as a field on
  the results object itself (`connection.type`), shown again on the results
  screen and included in any copied/shared result text — so a relayed
  result can never be mistaken for a direct one, even out of context.
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
      (decision 2).
    - `paired` — ICE connected; the direct-vs-relayed badge (decision 2) is
      now known and shown; both peers see a "ready to test" state (possibly
      with a manual or auto-start trigger — exact trigger is a Phase 2/3
      implementation detail, not fixed here).
    - `testing` — latency (Phase 3) then throughput download/upload
      (Phase 4) phases run in sequence, with live numbers shown to both
      peers as they're measured.
    - `result` — final numbers (latency, download, upload, connection type)
      are shown in-place on the room page immediately after the test
      completes, *and* the same result record is written to `localStorage`
      (decision 7) so it also shows up later on the results page. The room
      page's result view is the "just finished, both peers looking at it
      together" view; the results page (below) is the durable history.
  - Connection-state errors (peer disconnected mid-test, ICE/TURN failure)
    are handled as sub-states of `pairing`/`testing`, not separate routes.
- **Results page — `/results` (local history, detail view, import/export)**
  - Reads exclusively from `localStorage` (decision 7) — no network calls,
    no room/DO interaction. Works standalone even if no test was ever run
    in this browser (empty state).
  - **List view** (default): every stored result as a row/card — timestamp,
    download/upload/latency summary, connection type (direct/relayed)
    badge. Sorted newest first.
  - **Detail view**: selecting an entry (e.g. `/results/:id`, `id` being
    the result's locally-generated identifier) shows its full record —
    same fields as the room page's post-test summary, so nothing is lost
    by navigating away from the room page.
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

- **Storage**: results are stored in the browser's `localStorage` under a
  single namespaced key (e.g. `p2p-speedtest:results`) as a JSON array of
  result records. `localStorage` (not `IndexedDB`) is sufficient given the
  expected record count and size (a handful of numeric fields per test) —
  revisit only if real usage shows otherwise.
- **Record shape** (fixed by this decision so Phase 4/5 and the results
  page agree on one schema from the start):
  - `id` — locally generated unique identifier (e.g. `crypto.randomUUID()`).
  - `completedAt` — ISO timestamp of test completion.
  - `connection.type` — `"direct" | "relayed"` (decision 2).
  - `latency` — `{ rttMs, jitterMs }`.
  - `download` / `upload` — `{ mbps }` (and any secondary metrics from
    decision 5, e.g. packet loss, once implemented).
  - `roomSlug` — the Room ID the test ran in, for reference only (the room
    itself is long gone by the time this is read back).
  - A `schemaVersion` field from day one, so future field changes can be
    migrated on read instead of silently breaking old imported files.
- **Write path**: the room page writes exactly one record per completed
  test, at the moment the `result` state (decision 6) is reached — written
  once, never mutated afterward.
- **Import merge rule**: importing a JSON export merges by `id` — entries
  whose `id` already exists locally are skipped (first-write-wins; imports
  never overwrite existing local history), everything else is appended.
  Malformed entries (failing schema/shape validation) are skipped
  individually with a visible warning, not a fatal import error for the
  whole file.
- **Export format**: the exported JSON is exactly `{ schemaVersion, results:
  [...] }` — the same shape read back on import — so export-then-import
  round-trips losslessly and files are portable between browsers.
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
handling, phase sequencing (download then upload, roles swapped), live
Mbps display, final results view shown to both peers on the room page
(decision 6 `result` state), with connection type (direct/relayed) attached
to and displayed alongside the results. On reaching `result`, each peer
writes its result record to `localStorage` per the schema and write path in
decision 7 — this is the point the results page (Phase 5) starts having
data to show.

### Phase 5 — Results page, polish & robustness
Build the `/results` page (decision 6): list view, detail view
(`/results/:id`), and the import/export mechanism (decision 7, incl. the
merge-by-`id` rule and per-entry import validation). Also: room
expiry/cleanup edge cases, reconnect/error handling (peer closes tab
mid-test, ICE/TURN failure messaging), QR code and copy-to-clipboard UI
refinement, responsive layout across all three pages, basic result sharing
from both the room page and results page (copy results text/link,
including connection type in the copied output).

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
- [ ] The connection-type badge (direct vs relayed) is accurate and visible
      before and after the test, and appears in the results data/summary.
- [ ] Latency (RTT) is measured and displayed live.
- [ ] Download and upload throughput are each measured and displayed, with a
      final results summary visible to both peers.
- [ ] Room state is cleaned up (DO alarm) after peers disconnect or go idle;
      a stale peer slot can be replaced by a 3rd joiner, but a live peer
      never gets evicted just because someone else has the join info.
- [ ] The home page (`/`), room page (`/room/:slug`), and results page
      (`/results`, `/results/:id`) exist as the three top-level routes per
      decision 6, each scoped to its own responsibility.
- [ ] Completed results are written to `localStorage` per the decision 7
      schema and are visible on the results page's list and detail views.
- [ ] Results can be exported to a JSON file and re-imported (including
      into a different/empty browser storage) without data loss or
      duplication, per the decision 7 merge rule.
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
3. Add repo-specific Worker integration constraints to the master plan so Phase 1 implementation plans include Durable Object config, routing, and migration work.

## Re-Review Feedback (Codex, 2026-07-29)

### Review State
- **Status: APPROVED**

### Assessment
- **P1**: Resolved. The plan no longer claims a 7-emoji key can encode a 128-bit token. It now deliberately uses a 42-bit room token, makes the Room ID and emoji key bijective encodings of that same value, and records the reduced-entropy tradeoff plus collision retry and abuse mitigation.
- **P2**: Resolved. The 3rd-join behavior now has a single rule: live peer slots are protected, stale slots can be replaced, and stale detection is tied to socket close/error or missed heartbeats.
- **P2**: Resolved. The React Router + Cloudflare Worker integration path is now explicit: API dispatch happens before the React Router handler, `SignalingRoom` must be exported, and `wrangler.jsonc` must add the Durable Object binding and migration.

### Follow-Up For Claude (Phase 1 Plan)
1. Specify the concrete rate-limiting mechanism for room lookup/join attempts, since the master plan relies on throttling to make the 42-bit room-token choice acceptable.

## Amendment (2026-07-29): Page/route definitions

Added decision 6 (Pages / routes) defining the three top-level pages —
home (`/`, branding + create/join), room (`/room/:slug`, all speedtest
logic and its `waiting → pairing → paired → testing → result` states), and
results (`/results`, `/results/:id`, local history + detail + import/
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
