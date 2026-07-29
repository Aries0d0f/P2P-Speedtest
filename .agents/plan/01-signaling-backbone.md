# Phase 1 — Signaling Backbone

> **Status**: APPROVED
> **Created**: 2026-07-29
> **Implements**: [main-plan.md](./main-plan.md) — S1 (room identity),
> S2 (rooms, peers, runs), S3 (peer id), S9 (repo integration),
> S10 (rate limits)

## Goal

Two browsers open a WebSocket to the same room and exchange messages through
a `SignalingRoom` Durable Object. No WebRTC yet — the phase is proven with a
raw echo test between two tabs.

Three things settled here are load-bearing for everything after: the token
encoding, the message envelope, and the peer-slot lifecycle.

## Scope

**In:** room-token module, `SignalingRoom` DO, Worker `/api/*` dispatch,
rate limiting, `wrangler.jsonc` binding and migration, minimal create/join
UI.

**Out:** WebRTC, TURN credentials (Phase 2), the real room-page state
machine, results.

## Current state of the repo

- `workers/app.ts` forwards every request to the React Router SSR handler.
- `wrangler.jsonc` has no `durable_objects` binding and no `migrations`.
- `app/routes.ts` declares only `index("routes/home.tsx")`.
- No test runner is configured.

## Design notes

### Token encoding

One 42-bit random integer is the source of truth (S1), with three reversible
derivations:

- **`slug`** — Crockford base32, 9 characters, zero-padded. 9 × 5 = 45 bits
  of capacity covers 42. The alphabet is `0-9` and `A-Z` without I, L, O, U;
  the schema's `roomId` pattern enforces exactly that set, so an encoder that
  emits an excluded letter fails validation rather than producing an
  unstorable slug. Encoding outputs canonical uppercase; decoding accepts
  Crockford's usual leniency (case-insensitive, `I`/`L` → `1`, `O` → `0`) so
  a mistyped Room ID still resolves.
- **`emojiKey`** — 7 characters over a fixed 64-entry emoji array, 6 bits
  each, exactly 42.
- Decoding either returns the identical integer.

The **slug** is the canonical string form everywhere a room is referenced —
`idFromName`, the WebSocket URL, and the `peer-id` name string (S3) — so
there is one spelling of a room in the system.

The module is isomorphic: both sides encode, decode, and resolve join input;
only the server calls `generateToken`.

### Room creation is server-owned

The client never generates a token, because there would be nowhere to
rate-limit creation or retry collisions. `POST /api/rooms`:

1. Apply the create-scope rate limit to the source IP; `429` if exceeded.
2. `generateToken()`.
3. Ask the addressed DO to **claim** the token. On collision, regenerate and
   retry, capped at 5 attempts, then `503` — at 42 bits, repeated collisions
   mean a bug, not bad luck.
4. Respond `201 { slug, emojiKey, link }`.

Claiming at creation rather than at first connect closes the window where
two browsers could race on the same freshly generated token. A
claimed-but-unopened room is S2's **reserved** state and expires on its own.

Creation hands out no role, no credential, and no claim on a particular
slot.

### Slots are assigned by arrival

The first socket accepted takes slot 0, the second takes slot 1 (S2). There
is no creator token and no role proof: the DO makes no attempt to tell the
person who created a room from the person they invited.

Nothing downstream needs creator identity — Phase 4's role mapping needs
only a stable, distinct pair of slot numbers. A creator credential would
also be a false guarantee, since a stale slot 0 can be taken over before the
run starts and no token survives that.

Worth remembering while building UI: the creator normally connects first,
because their browser opens the socket on navigation before they have shared
the link. A slow tab or an eagerly-pasted link inverts it, and nothing may
break when it does.

### Message envelope

```
{ type, runId, payload }

type ∈
  peer-assigned                          // DO → one peer, on accept
  peer-joined | peer-left                // DO → the other peer
  ping | pong                            // heartbeat
  run-started | run-ended                // DO → both peers
  run-finished                           // one peer → DO, lifecycle ack
  ice-servers                            // Phase 2, DO → one peer, per run
  test-config                            // Phase 4, DO → one peer, on accept
  offer | answer | ice-candidate         // Phase 2, relayed verbatim
```

**That is the whole set, and it is meant to stay that way.** Every type is
either the DO telling a peer something about the room, a lifecycle-only
acknowledgement, or an opaque blob relayed between peers. None carries peer
names, application-profile addresses, geolocation, measurements, result
status, or result records — those travel peer-to-peer over the data channel
(S3, S6). A message type that would route peer data through the DO is a
design change, not an extension.

**`runId` is a UUIDv4** with one representation per transport: canonical
lowercase text in JSON envelopes, and the same 16 bytes in network order in
Phase 4's binary bulk header. Ship encode/decode round-trip fixtures — the
two representations are written by different code in different phases, and a
mismatch surfaces as bulk chunks being silently uncounted.

It lives **on the envelope, not in payloads**, so the check is one rule in
one place rather than a field every later phase must remember. The DO drops
any inbound message whose `runId` is not current, and stamps the current run
on everything it sends. Messages issued at accept, before a run exists —
`peer-assigned` and `test-config` — carry `runId: null`. `ice-servers` does
not: credentials are per run (S4), so it always carries a real one.

**`peer-assigned`** is the connect acknowledgement, sent to a single socket
immediately on accept:

```
{ type: "peer-assigned", runId: null,
  payload: { slot: 0 | 1, peerId: <uuid>, expiresAt: <ISO 8601> } }
```

It is distinct from `peer-joined`, which tells a peer that *the other side*
arrived. Conflating them would leave later phases guessing whether a message
describes the recipient or its counterpart. Both peers need `peerId` to
label the edges they exchange and `slot` to know which direction each
receives; `expiresAt` is the room's hard expiry (S2), so the UI can warn
before it lands.

**`test-config`** is reserved here and its trigger is fixed here, so Phase 4
does not have to invent one. At room claim, the DO snapshots one
`{ maxDurationMs, maxBytes, chunkBytes }` value from the current service
configuration and stores it with the room. It sends that stored value on the
same server-observable event as `peer-assigned` — socket accept — on that
same socket.

Nothing tells the DO when the browsers reach `paired` and nothing needs to,
since a config issued at accept is in the client's hands long before a test
can start. One accept, one `test-config`; every accept in that room receives
byte-equivalent parameters, including a socket that replaces a stale
pre-run slot. A deployment or configuration change affects only rooms
claimed afterwards. Phase 4 owns how clients apply the payload.

**`run-started` / `run-ended`** carry the run lifecycle (S2):

```
{ type: "run-started", runId: <id>, payload: { peers: [{slot, peerId}, ...] } }
{ type: "run-finished", runId: <id>, payload: {} } // peer → DO
{ type: "run-ended", runId: <id>,
  payload: { reason: "peer-left" | "expired" | "complete" | "finalization-timeout" } }
```

`run-started` fires when the second slot fills; `run-ended` when the run
stops for any reason, and it is **terminal** — a room hosts one run (S2), so
nothing follows it.

`run-finished` is the data-free graceful-completion transition that makes
`run-ended: complete` reachable. Phase 4 sends it only after that peer has
finished local finalization: its result is shown and its one persistence
attempt has resolved, successfully or with a visible storage error. The
message says only "this slot finished finalization"; `complete` therefore
means lifecycle completion, not necessarily `data.status: SUCCEED`.

The DO derives the sender's slot from the socket attachment, records one
finish acknowledgement per slot, and never trusts a client-supplied slot.
A duplicate from the same slot is a no-op. Once both slots have
acknowledged, the DO atomically marks the room terminal and broadcasts
exactly one `run-ended` with `reason: "complete"`.

The first finish acknowledgement also starts a fixed finalization grace
deadline of about 5 seconds. If the second never arrives, the DO broadcasts
one terminal `run-ended` with `reason: "finalization-timeout"`; the survivor
can then freeze and persist its partial record. An acknowledgement with a
null, missing, stale, or non-current `runId` is dropped. Finish-ack state and
the deadline survive hibernation.

A peer receiving `run-ended` does not blindly erase live measurement state.
Phases 2–4 own the ordered handoff: freeze and finalize what exists first,
then tear down transport. This one message remains the common terminal
trigger rather than each layer inventing a different lifecycle.

## Work

### 1.1 Room token module

**`app/lib/room-token.ts`** (new)

`generateToken(): number` (crypto-random, 42-bit), `tokenToSlug` /
`slugToToken`, `tokenToEmojiKey` / `emojiKeyToToken`, and
`resolveJoinInput(input): number | null`, which distinguishes Room ID from
emoji key by content.

Hand-pick the 64-emoji alphabet per S1 and store it as a fixed ordered
array. Get the bit math exactly right before anything is built on it — this
is the highest-leverage correctness risk in the phase.

**Test runner.** The repo has none and this phase's exit criteria require
passing tests, so set one up here: **Vitest**, with
`@cloudflare/vitest-pool-workers` for the DO tests, and a `bun run test`
script. Phases 4 and 5 assume it exists.

**`app/lib/room-token.test.ts`** (new) — round-trips both ways, boundary
values (`0` and `2^42 - 1`), canonical output that never contains the
excluded Crockford letters, lenient decoding of the standard aliases, and
`resolveJoinInput` across both formats plus invalid input. This suite passes
before anything is built on the encoding.

*Risk: medium — bit-packing bugs surface as "wrong room", which is expensive
to debug later.*

### 1.2 `SignalingRoom` Durable Object

**`workers/signaling-room.ts`** (new)

Handles the WebSocket upgrade, assigns a slot and peer id on accept,
acknowledges with `peer-assigned`, relays messages between live sockets,
runs the heartbeat, enforces the third-join rule, and schedules cleanup.

Slot choice is the first free slot in order — 0 if empty or stale, otherwise
1 — with no inspection of who is connecting.

**Use the Hibernatable WebSockets API** (`ctx.acceptWebSocket`), not an
in-memory `Map`, so the DO can hibernate between messages without dropping
connections. Check current Workers docs for the exact API surface rather
than working from memory.

#### Peer identity

**On accept, record `{ slot, peerId, gen }` — and nothing else.** The
connection's `CF-Connecting-IP` serves rate limiting at the Worker (1.3) and
is not stored here: the DO has no use for it, and storing it would make the
room a place peer addresses accumulate (S2).

```
peerId = uuidv5(NAMESPACE, "room:" + slug + "|slot:" + slot + "|gen:" + gen)
```

`gen` is a fresh 128-bit `crypto.getRandomValues` hex string generated by
the DO at this accept.

No IP appears in the name. Two tabs behind one NAT share an address, so an
IP-derived id would collapse them into one identity and break the bandwidth
edge graph. `gen` is what makes each accepted socket distinct, and it keeps
the id from being a stable fingerprint of anything. Slot and room are in the
name only to make the value self-describing in logs.

Because `gen` is random per accept, a socket taking over a stale slot gets a
**new** peer id: a takeover is a new participant, never a resumption (S3).
There is no reconnect credential and nothing to restore.

`NAMESPACE` is a project-wide UUID pinned as a module constant. Any fixed
value works — peer ids live and die with a room, so nothing is invalidated
if the app's canonical URL changes. Use a real UUIDv5 implementation (the
`uuid` package's `v5()`) rather than hand-rolling SHA-1 and bit twiddling.

Send `slot` and `peerId` in `peer-assigned` before anything else on that
socket. That is the only time a peer learns either value; the DO never
accepts a client's claim about its own identity afterwards.

#### Liveness and the third-join rule

Heartbeat ping with a ~15s response timeout. A slot goes stale on socket
close/error or two consecutive missed heartbeats. Before a run starts, a new
connection may replace only a stale slot. Once a run starts, reject every
further connection; a departed run participant makes the room terminal
instead of replaceable (S2).

#### Hibernation-safe state

The DO can be evicted between messages, so every fact the ownership rules
depend on has to survive a wake:

| State | Where | Why |
|---|---|---|
| `{ slot, peerId, gen }` | Socket attachment (`serializeAttachment`) | Travels with the socket; `ctx.getWebSockets()` after a wake returns the socket *and* who it is |
| `expiresAt`, `claimed`, `runId`, `testConfig` | Durable storage | Room-level, outlives every socket; the config is one immutable room snapshot |
| Finish acknowledgements and deadline | Durable storage | Duplicate-safe graceful completion must survive a hibernation wake |
| Heartbeat deadlines | Durable storage, keyed by slot | A wake must distinguish stale from live without waiting another interval |

Reconstruct on wake from `ctx.getWebSockets()` plus storage — never from
module-level variables, which are empty after eviction and would report both
slots free, letting a third joiner evict a live peer.

**Accept and replace are atomic.** Two sockets arriving in the same instant
must not both be handed slot 0. Do the read-decide-write of the slot table
in one `ctx.blockConcurrencyWhile`: read slot state → decide
reject/assign/replace → if replacing, close the stale pre-run socket → write
the new record → `peer-assigned`.

#### Runs and takeover ordering

A room hosts exactly one run (S2). The DO:

- issues a fresh `runId` and broadcasts `run-started` when the second slot
  fills, which is also the trigger for per-run ICE credentials (Phase 2);
- allows a stale slot to be taken over **only before a run has started** —
  that covers a tab crashing while it is the only waiting peer, which should
  not cost anyone a new room;
- once a run has started, **ends it and the room together**: broadcast
  `run-ended`, mark the room terminal, reject further connections, and let
  cleanup run. No second run is ever admitted.
- records `run-finished` idempotently by the attachment-derived slot,
  broadcasts `run-ended: complete` after both peers finish local
  finalization, and uses the finalization grace deadline when only one
  acknowledgement arrives;
- drops any inbound message whose envelope `runId` is not current.

Store `runId`, the terminal flag, finish acknowledgements, and their
deadline in durable storage, for the same reason slot records live there,
and delete them at cleanup.

That is all a run needs here. The DO does not track how far a test got and
does not decide any outcome: each peer applies S6's measurement boundary to
its own data. The DO's only duty when a run ends is to say so, promptly, so
both peers can store what they hold.

Room-per-run is what keeps stored records uniquely identified — S2 has the
reasoning. It also removes an ordering hazard for free: with no replacement
to admit, a straggling message from the ended run has no new run to be
misread into.

#### Expiry: two clocks, one alarm

S2 requires a non-refreshable hard expiry and a refreshable idle timeout.
Store `expiresAt` at claim time and **never rewrite it**. Track
`lastActivityAt` separately, refreshed by accept, message, and heartbeat.

A DO supports one alarm, and four deadlines need it. Schedule at

```
min(expiresAt, lastActivityAt + idleWindow, nextHeartbeatAt, finishDeadline)
```

and re-evaluate after every wake and every activity. Activity may push the
idle deadline out, never past `expiresAt`.

Omitting `nextHeartbeatAt` is a silent failure, not a cosmetic one: a
hibernated room never wakes to notice two missed heartbeats, so a
disconnected peer stays "live" forever and the takeover path never runs —
the third-join test would fail with no obvious cause.

On wake, act on whichever fired, then reschedule at the new minimum:

- **Hard expiry** — broadcast `run-ended` with `reason: "expired"`, close
  both sockets with a code the room page maps to "this room expired", delete
  all state.
- **Heartbeat** — mark any slot past its deadline stale. If that ends a run,
  follow the takeover ordering above. Set `nextHeartbeatAt` to the earliest
  remaining deadline.
- **Finalization grace** — if exactly one slot acknowledged
  `run-finished`, broadcast one `run-ended` with
  `reason: "finalization-timeout"` and mark the room terminal. If both
  already acknowledged, the normal completion path has already won.
- **Idle** — no live sockets and nothing happening: delete all state.

Either path clears `claimed`, returning the token to circulation (S1). An
abandoned claim is covered because the claim itself schedules the alarm;
without that, nothing would wake the DO and the token would be retired
permanently.

*Risk: high — hibernation, the three-deadline alarm, and the live/stale
state machine are the trickiest code in the phase, and their failure modes
are silent. Wrong state after a wake looks like normal operation until a
live peer is evicted.*

### 1.3 Rate limiting

**`wrangler.jsonc`** (bindings) + **`workers/app.ts`** (enforcement)

Cloudflare's Rate Limiting binding carries one namespace and one policy
each, so two policies means **two bindings**:

| Binding | Limit | Applies to |
|---|---|---|
| `CREATE_RATE_LIMITER` | 5 / minute | `POST /api/rooms` |
| `JOIN_RATE_LIMITER` | 20 / minute | `/api/room/:roomToken` upgrade attempts, counted even when rejected |

Both keyed on `CF-Connecting-IP`. Join is more generous because legitimate
reconnects — refresh, network blip — land there. On exceeding either, return
`429`: with `Retry-After` on create, and before any DO or socket work on the
join path.

Each needs its own `namespace_id`. Confirm the current config key names
against the docs first; this binding type has changed shape more than once.

**Fallback if the binding is unavailable**, and it must be restart-safe,
because an in-memory counter resets to zero on eviction and hands an
attacker a fresh budget exactly when the DO is under load:

- A dedicated limiter DO, **sharded by a hash of the IP** (e.g. 16 shards)
  so one instance is not a global chokepoint on every join.
- Counters in **durable storage** with an explicit expiry timestamp, swept
  lazily on read rather than with an alarm per key.

Not the Cache API — its edge-consistency behaviour across Cloudflare's
network is worse than a sharded DO here.

### 1.4 Worker dispatch

**`workers/app.ts`**

Dispatch on an explicit table before falling through to `requestHandler`,
with no ambiguous cases:

| Request | Behaviour |
|---|---|
| `POST /api/rooms` | Create flow (rate limit → generate → claim → retry ≤5 → `503`), then `201 { slug, emojiKey, link }` |
| `/api/room/:roomToken` **with** `Upgrade: websocket` | Join rate limit → decode token (`400` if invalid) → forward to `SIGNALING_ROOM.idFromName(slug).get(id).fetch(request)` |
| `/api/room/:roomToken` **without** the upgrade header | `426 Upgrade Required` |
| Anything else under `/api/*` | `404` |
| Everything else, including `/room/:slug` | Falls through to React Router unchanged |

There is deliberately **no ICE-servers endpoint**. Credentials travel over
the signaling socket (S4), so the only HTTP surface is room creation and the
upgrade; an endpoint authorized by nothing more than knowing a 42-bit slug
would undo the point.

**Also**: `export { SignalingRoom } from "./signaling-room"` — DO classes
must be reachable from the module Wrangler treats as `main` (S9).

**`wrangler.jsonc`**: add
`durable_objects.bindings: [{ name: "SIGNALING_ROOM", class_name: "SignalingRoom" }]`
and `migrations: [{ tag: "v1", new_sqlite_classes: ["SignalingRoom"] }]`,
then run `bun run cf-typegen` so `Env` picks up the binding.

*Risk: medium — must not regress SSR for any other path.*

### 1.5 Minimal create/join UI

**`app/routes.ts`** — add `route("room/:slug", "routes/room.tsx")`.

**`app/routes/home.tsx`** — "Create a test" calls `POST /api/rooms` and
navigates to `/room/:slug` with the returned slug. "Join a test" is a single
input resolving a pasted link, Room ID, or emoji key client-side via
`resolveJoinInput`, then navigating to the same route. Whether the room
exists is discovered at WebSocket connect time.

**`app/routes/room.tsx`** (new) — on mount, derive the token from `:slug`,
open the WebSocket, display the QR/link, Room ID, and copy-paste emoji key,
and show a bare "peer joined" indicator plus an echo box.

This UI is deliberately throwaway: it exists to verify the backbone by hand.
Phase 2 replaces the indicator with the real state machine, Phase 5 does the
visual work.

## Risks

| Risk | Mitigation |
|---|---|
| Hibernation/alarm API differs from assumptions | Read current Cloudflare docs before writing 1.2; do not guess the API surface |
| Off-by-one in base32 or emoji bit-packing near the 42-bit boundary | Exhaustive round-trip tests including `0` and `2^42 - 1` |
| Rate Limiting binding unavailable in this Wrangler version | Verify first; the sharded, storage-backed DO fallback is specified, not an open decision |
| DO state read from module-level variables looks correct until an eviction | Attachment + storage model in 1.2, with a hibernation-wake test in the exit criteria |
| Hard expiry quietly becomes refreshable by sharing a timestamp with idle | Two separate fields, one alarm at `min(...)`, and a test that heartbeats cannot extend expiry |
| Collision-retry loop masks a broken `generateToken` | Hard cap of 5 retries then `503`, so the problem surfaces immediately |
| A duplicate finish acknowledgement ends the room before the other peer saves | Finish state is keyed by attachment-derived slot; one slot can contribute at most one acknowledgement |
| Waiting peers receive different test limits across a deployment | Snapshot `testConfig` once at claim and replay that stored value on every accept |

## Done when

**Tokens and dispatch**

- [ ] Token round-trips through slug and emoji key, boundary values
      included, with passing tests.
- [ ] `runId` round-trips between canonical text and 16-byte network order.
- [ ] `SignalingRoom` is exported, bound, and migrated; `cf-typegen`
      succeeds and `Env` includes the binding.
- [ ] `POST /api/rooms` returns a fresh room, and retries correctly when a
      collision is forced.
- [ ] Any `/api/*` path other than `POST /api/rooms` and the room upgrade
      returns `404`; the upgrade path without the header returns `426`.
- [ ] `/` and `/room/:slug` still render via SSR; `/api/room/*` is not
      swallowed by the SSR handler.
- [ ] Both rate-limit scopes return `429` once exceeded.
- [ ] **The limiter survives a restart**: exhaust the join limit, restart the
      limiter DO, confirm the budget has not reset.

**Peers and slots**

- [ ] Each socket receives exactly one `peer-assigned` on connect, carrying
      its own `slot` and `peerId`, before any other message — and the two
      peers get different slots and different peer ids.
- [ ] Two tabs **on the same machine**, hence one public IP, receive
      different peer ids. This is the default local test setup, so it is the
      cheapest thing to get wrong and not notice.
- [ ] A tab taking over a stale slot receives a *different* peer id from the
      socket it replaced, in the same room.
- [ ] Slot assignment follows arrival order regardless of who created the
      room: connecting the invitee's tab first gives it slot 0, and nothing
      downstream misbehaves.
- [ ] Two tabs joined by each of the three methods relay an echo message
      through the DO.
- [ ] Killing one tab's network without a clean close does not let a third
      tab in until the heartbeat timeout elapses — and does after.
- [ ] A live, responsive peer is never evicted by a third join attempt.

**Lifetime and hibernation**

- [ ] **Hibernation wake**: force an eviction mid-session, then confirm the
      DO rebuilds `{slot, peerId, gen}` from `ctx.getWebSockets()` plus
      storage — a live peer is still live, a third joiner still rejected.
- [ ] **Heartbeat detection survives hibernation**: let a room hibernate,
      kill one peer's network without a clean close, and confirm the alarm
      wakes and marks the slot stale on schedule. This is what makes the
      takeover test above meaningful rather than only passing while the DO
      happens to be resident.
- [ ] **Hard expiry cannot be extended**: a room held open by a peer sending
      heartbeats still closes at `expiresAt`, with `run-ended` /
      `reason: "expired"` and a close code the page can show.
- [ ] **Idle refresh still works**: activity pushes idle cleanup out, never
      past `expiresAt`.
- [ ] An idle room is cleaned up by the alarm, confirmed via logs rather
      than code reading.
- [ ] A room created and **never opened** is cleaned up by the same alarm,
      and its claimed flag is gone afterwards.
- [ ] Both original peers receive byte-equivalent `test-config` payloads.
      Change the service defaults while slot 0 waits and confirm slot 1
      still receives the room snapshot.
- [ ] A stale pre-run replacement receives the same stored `test-config` as
      the socket it replaced.
- [ ] **A stale slot is replaceable before a run starts**: kill slot 0's tab
      while it waits alone, and a new tab takes the slot.
- [ ] One peer sending `run-finished` twice does not end the room. After the
      other peer sends it once, the DO emits exactly one
      `run-ended: complete`; neither lifecycle message contains profile,
      measurement, status, or result data.
- [ ] If only one `run-finished` arrives, the hibernation-safe finalization
      deadline emits exactly one `run-ended: finalization-timeout`.
- [ ] **A room is terminal once its run ends**: after `run-ended`, a fresh
      connection attempt is rejected rather than starting a second run, and
      a message replayed with the old `runId` is dropped.
- [ ] **The DO stores no peer data.** Dump its storage and socket
      attachments after a full run: only room, slot, run, and test-parameter
      fields — no address, name, or measurement.
- [ ] `bun run test`, `bun run typecheck`, and `bun run build` pass.

## Order

1.1 and 1.2 are independent and can run in parallel. 1.3 is Worker-level and
independent of both. 1.4 depends on all three; 1.5 on 1.1 and 1.4.

Do not start Phase 2 until the echo test and the stale-eviction test pass by
hand — Phase 2 reuses this exact connection and envelope for SDP/ICE.

## Review Feedback (Codex, 2026-07-29)

### Review State
- **Status: APPROVED**

### Assessment
- All review findings are resolved. The lifecycle handshake and room-stable
  test configuration are explicit, durable, and verifiable.
