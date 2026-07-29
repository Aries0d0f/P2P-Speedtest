# Phase 2 — WebRTC Connection

> **Status**: APPROVED
> **Created**: 2026-07-29
> **Implements**: [main-plan.md](./main-plan.md) — S4 (NAT traversal and
> relay disclosure), S3 (self-description and privacy mode),
> S8 (`pairing`/`paired`, the confirm step)
> **Builds on**: [Phase 1](./01-signaling-backbone.md) — the signaling
> socket and its run-scoped envelope

## Goal

Turn Phase 1's signaling channel into a real `RTCPeerConnection`: offer,
answer, ICE exchange, TURN credentials, both data channels, an honest
direct-vs-relay badge, and the first thing the peers say to each other —
who they are.

Nothing is measured yet.

## Scope

**In:** socket-delivered ICE configuration and the TURN provider adapter,
peer connection setup, both data channels, relay classification, the badge,
the `pairing`/`paired` states, the profile confirm step, and the direct
peer-to-peer profile exchange.

**Out:** anything measured (Phases 3 and 4).

## Design notes

### ICE configuration arrives on the socket

There is no ICE-servers endpoint. The DO mints credentials and pushes them
to each live peer **at `run-started`** — once per peer per run, immediately
before negotiation needs them (S4):

```
{ type: "ice-servers", runId: <run>,
  payload: { iceServers: RTCIceServer[] } }
```

Holding an accepted socket *is* the authorization. An HTTP endpoint gated on
"this slug names a room" would let anyone who guessed or was forwarded a
slug mint relay credentials without ever joining, repeatedly.

**Why the run and not the accept.** Slot 0 can sit alone for minutes, and a
credential minted at its accept may be dead by the time a partner arrives —
surfacing as an unexplained ICE failure. Issuing when the run starts means
the credential is minted at the moment negotiation needs it, and issuance
stays bounded because a room hosts exactly one run (S2).

**TTL is capped at the room's hard expiry.** The DO knows `expiresAt`
(Phase 1), so the lifetime is `min(providerTtl, expiresAt - now)`. A
credential outliving its room would reopen the relay-cost window the expiry
exists to close (S10).

**If too little time remains**, do not call the provider with a zero or
negative TTL — providers reject it, and the error surfaces as a mysterious
pairing failure. Define a floor (the provider's minimum, or ~60s if it has
none). Below it, skip minting: end the run with `run-ended` /
`reason: "expired"` and show the expiry state. A room with under a minute
left cannot host a test anyway.

The payload is a plain array combining static public STUN entries with one
TURN entry. **This shape stays provider-neutral** — swapping providers must
never change what the client sees (S4).

### TURN provider adapter

**`workers/turn-provider.ts`** exposes exactly one function, called by the
DO:

```
mintTurnCredentials(ttlSeconds: number): Promise<RTCIceServer | null>
```

The caller passes the already-capped TTL, so the adapter never has to know
about room lifetimes. All provider-specific request shaping stays inside
this file.

Default implementation is Cloudflare Realtime/Calls TURN, reading
`TURN_PROVIDER_APP_ID` (plain var) and `TURN_PROVIDER_APP_SECRET`
(`wrangler secret put`, never committed). Verify the actual credential API
against current official docs before writing it.

**Dev fallback:** if the secret is unset, return `null` rather than throwing;
the caller sends STUN-only with a console warning. That keeps same-network
development working without production secrets. Forced-relay testing
genuinely needs real credentials, and the fallback should not pretend
otherwise.

### Negotiation contract

Three ordering hazards, each with a fixed rule rather than left to instinct:

**Who offers.** Slot 0, always. Both sides know their slot from
`peer-assigned`, so nothing is negotiated.

**Candidates arriving early.** A remote candidate can arrive before
`setRemoteDescription`, and adding it then throws. Queue remote candidates
until the remote description is set, flush in arrival order, then add
directly. Treat a null/empty candidate as end-of-candidates but do not rely
on it arriving — not every browser sends one.

**Classification is not stable at first connect.** The selected pair can
change moments after `connectionState` reaches `connected`, when a better
pair wins late. Re-read `getStats()` until a nominated pair with both
candidate types exists, poll briefly after that (a second or so), and report
only the settled value.

### Terminal handoff precedes transport teardown

Phase 1's `run-ended` is the single room-lifecycle trigger (S2), but it is
**not** permission to erase measurement state first. Teardown is ordered by
whether measurement began:

| State when terminal trigger arrives | Ordered response |
|---|---|
| `waiting` / `pairing` / `paired` before the testing barrier | Tear down immediately; no record exists |
| `testing` | Freeze latency/throughput state, run Phase 4's terminal finalizer, attempt the local write, then tear down |
| `finalizing` | Join the already-running finalizer; do not start another or tear down underneath it |
| `result` | Result is already immutable; tear down transport and keep the view |

Expose two separate operations from the transport wrapper:

- `stopProducing()` prevents new negotiation, stage-control, ping, and bulk
  production without clearing data already handed to measurement modules.
  It deliberately leaves terminal control messages (`test-abort` and
  `result-share`) plus signaling `run-finished` available while those
  transports remain writable.
- `teardown()` closes the peer connection and channels and clears transport
  queues. It runs only after the terminal finalizer settles, or immediately
  on a pre-measurement end.

Phase 4 registers one `finalizeTerminal(trigger)` callback keyed by `runId`.
The first post-start trigger creates its promise; simultaneous
`run-ended`, ICE failure, channel close, and user cancellation calls join
that same promise. A later `FAILED` cause may strengthen a pending
`CANCELED` outcome before the record is sealed, but no trigger can cause a
second result share, write, or teardown.

`run-ended: complete` normally arrives only after both peers have already
finished local finalization and sent Phase 1's `run-finished`; it therefore
tears down while leaving the `result` view and stored badge intact. For
`peer-left`, `expired`, or `finalization-timeout`, the finalizer first saves
whatever snapshot is available. If the data channel is already gone, it
skips peer exchange and uses the local half; it never waits on dead
transport.

Every reason is terminal, because a room hosts exactly one run (S2). There
is no returning to `waiting` for a replacement once a run has started — a
further test needs a new room.

### A local pre-measurement failure ends the DO run

An ICE/negotiation failure or initial-profile timeout can happen locally
after `run-started` but before the testing barrier. Merely closing the peer
connection is insufficient: the signaling socket would still occupy its
slot and the other browser would wait in a live server run.

All such paths call one idempotent
`abortPreMeasurement(localReason)` **before** transport teardown:

1. Freeze the local terminal UI reason; no result snapshot or write is
   created because measurement never began.
2. If the signaling WebSocket is open, call
   `close(4401, "pre-measurement-failed")`. `4401` is this application's
   private close code; the detailed local cause stays in the browser and is
   not added to signaling payloads.
3. Phase 1's post-`run-started` socket-close rule atomically makes the room
   terminal and broadcasts its existing `run-ended { reason: "peer-left" }`
   to the surviving socket. A later join is rejected because a run already
   started and ended.
4. Call `teardown()` locally. Re-entrant ICE, timeout, socket-close, and
   channel-close callbacks join the same abort and cannot close twice or
   replace the first UI reason.

If the signaling socket itself has already failed, its server-observed
close—or Phase 1's heartbeat timeout for an unclean loss—is the same
room-terminal action. The local browser still tears down immediately; the
other browser becomes terminal as soon as the DO observes that loss.

## Work

### 2.1 DO-side ICE issuance

**`workers/signaling-room.ts`** (extend) + **`workers/turn-provider.ts`** (new)

On `run-started`, for each live peer: compute the capped TTL from
`expiresAt`, call `mintTurnCredentials(ttl)`, and send `ice-servers` on that
peer's socket, stamped with the run. On a `null` return, send the STUN-only
array and log a warning.

A provider error must not block the run — send STUN-only and let the
connection try, rather than leaving peers with no configuration at all.

Mint per peer rather than sharing one credential: providers generally bind
credentials to a single client, and a shared one fails in ways that look
like a network problem.

*Risk: medium — needs real TURN credentials via `wrangler secret put`.
Confirm Cloudflare Realtime/Calls access before starting; if it is
unavailable, treat provider selection as a blocking decision to raise rather
than guessing.*

### 2.2 Peer connection and channels

**`app/lib/webrtc.ts`** (new)

Wraps `RTCPeerConnection`: take the ICE servers delivered on the socket,
drive offer/answer negotiation from signaling messages, exchange ICE
candidates, and expose connection-state changes as callbacks. Keep WebRTC
plumbing out of the route component.

**Create both channels here, before slot 0's initial offer:**

| Label | Config | Used by |
|---|---|---|
| `control` | reliable, ordered | 2.6's profile exchange, Phase 3's ping/pong, Phase 4's stage FSM and result exchange |
| `bulk` | `ordered: false, maxRetransmits: 0` | Phase 4's throughput payload |

Slot 1 accepts both by label via `ondatachannel`, registered before it
applies the offer.

Both are created in this phase even though later phases own what flows over
them: a channel added to an already-connected peer connection triggers SDP
renegotiation, and there is no renegotiation flow. Creating them with the
first offer means there is never a second one — and this phase needs
`control` itself, for the profile exchange.

Implement the three rules from "Negotiation contract", and expose a
`stopProducing()` / `teardown()` pair that obeys the terminal ordering in
2.4 without reaching inside measurement modules.

*Risk: high — negotiation ordering is the main failure mode, and the
early-candidate case only shows up under real network timing.*

### 2.3 Relay classification

**`app/lib/webrtc.ts`**

Once `connectionState === "connected"`, read `getStats()`, find the nominated
candidate pair, and inspect `localCandidateType` / `remoteCandidateType`.
Classify `RELAY` if either is `relay`, otherwise `DIRECT` — uppercase,
matching `data.via` (S4). Poll until the pair settles, per "Negotiation
contract".

This local verdict drives the badge immediately and is what this peer shares
in Phase 4's result exchange. A peer never produces `UNKNOWN`: that value
exists for a record assembled with no classification available at all (S4).

**Forced-relay testing** uses `iceTransportPolicy: "relay"` on the
`RTCPeerConnection` config, behind a test-only switch (query flag or dev
build), and requires real TURN credentials. Name it in code so the browser
matrix below is reproducible rather than folklore.

*Risk: medium — `getStats()` report shapes differ across browsers; verify
the nominated-pair lookup on all three.*

### 2.4 Room states and badge

**`app/routes/room.tsx`** — replace Phase 1's throwaway indicator with real
`waiting → pairing → paired` transitions driven by the connection-state
callbacks (S8).

**`ConnectionBadge`** (shared component) — persistent and non-dismissable,
shown the moment the type is known. Build it reusable: Phase 4's result view
and Phase 5's results page both use it, and Phase 5 adds the `UNKNOWN`
state.

**On `run-ended`**, call the ordered terminal handoff above. Only a
pre-measurement terminal path calls `teardown()` directly; a post-start path
awaits Phase 4's idempotent finalizer first. Every reason lands on a terminal
state, so no `run-started` can follow.

**On a locally detected pre-measurement failure**, call
`abortPreMeasurement(reason)` rather than `teardown()` alone. The signaling
close must be initiated before the peer connection and channels are cleared,
so the DO terminates the run and releases the other peer from `pairing`.

Each terminal state offers a link to create a new room. The expiry state
reads as "this room expired" — it is not a connection error and should not
look like one.

### 2.5 The confirm step

**`app/lib/peer-profile.ts`** (new) + **`app/routes/home.tsx`** (extend)

The self-description from S3, captured **before** the room is entered. Both
entry paths pass through the same screen, which is why it lives in the
profile module rather than being written twice:

1. Read `navigator.userAgent`.
2. Generate a default name with **UAParser.js** — browser plus OS reads
   naturally and is what a person recognises as their device, e.g.
   `Chrome on macOS`. Fall back to a neutral label if parsing yields nothing
   usable.
3. Show the name, editable, plus a **privacy level** selector: Off
   (default), On, or Anonymous (S3).
4. On confirm, hold the profile for the session and proceed — create the
   room, or navigate to the join target.

**What each level changes:**

| Level | Default name | Sent to the other peer |
|---|---|---|
| Off | UA-derived | `name`, `ua`, full `ip`, full `geo` |
| On | neutral | `name`, full `ip`, full `geo` |
| Anonymous | neutral | `name`, **masked** `ip`, `geo` reduced to `{proxy, hosting}` |

Every field is the client's own to send or withhold — no server is involved
in the decision, and none has to be trusted to honour it. **The privacy
level itself is never transmitted**: what a peer receives simply is what was
shared, with nothing to infer from a level it cannot see.

From **On** upward the default name goes neutral, because announcing "Chrome
on macOS" while withholding the user-agent discloses the same thing through
the other field. The user can still type whatever they like.

Persist the last-used name and level in `localStorage` so a returning user
is not re-choosing every test; it is a preference, not a credential. Default
to Off on first use, and never silently downgrade a stored level.

*Risk: low mechanically, but the failure mode is a privacy promise that
isn't kept — verify on the wire, not in the UI.*

### 2.6 Own address, geo, and the exchange

**`app/lib/geo.ts`** (new) + **`app/lib/peer-profile.ts`** (extend)

**Determine this peer's own address locally.** Read the ICE candidates the
connection already gathered and take the **server-reflexive** candidate's
address — this browser's public address as seen from outside, available
without asking anyone. `protocol` follows from its family.

- Prefer the srflx candidate. Do **not** use the selected pair's local
  candidate: on a relayed connection that is the TURN server's address.
- With no srflx candidate (STUN blocked, or a LAN-only pairing), fall back
  to the host candidate in use — on a same-network test that *is* the
  address the peers used.
- With neither, omit `ip` and `protocol`. The schema allows their absence
  precisely because no server supplies them.

**Geo**, in parallel with ICE and never gating it: fetch
`https://ip.aries0d0f.me/?q=geo`, whose fields map directly to the schema's
`geo` object.

At **Anonymous**, project the response down to `{ proxy, hosting }` **at the
point of parsing**, not at the point of sending — an unfiltered object that
merely happens not to be sent yet is one refactor away from being sent.

The lookup still runs at Anonymous, which is a deliberate trade:
`ip.aries0d0f.me` is operated by the same person as the app, so contacting
it discloses the IP to nobody already outside the connection. If that proxy
ever moves to a third party, revisit this — the request itself would then
become the disclosure the level exists to prevent.

**Exchange over the control channel**, once it opens:

```
{ type: "peer-profile", runId,
  payload: { name, ua?, ip?, protocol?, geo?, timestamp? } }
```

**`timestamp` is slot 0's alone**, captured when slot 0 constructs its
initial profile and sent here rather than with the results. It is the
canonical run timestamp: when the run was readying to measure, **not** when
it completed. The main plan and schema define that meaning explicitly.
Two independently authored timestamps would produce different records for
one test, while sending it during pairing means slot 1 holds it before any
post-start failure can require a partial record. Slot 1 omits the field
entirely.

Each field is present only if the level allows it, and `ip` is already
masked by the sender when the level says so (S3). Omit a withheld field
rather than sending `""` or `{}` — "I have no geolocation" is not "I am not
sharing my geolocation".

**This never touches the signaling socket.** The DO has no message type for
it and would drop one (Phase 1). Routing peer data through the server would
undo the property S3 exists to establish, so use the data channel even
though the socket is right there and would have been easier.

Split the exchange into **initial profile** and **enrichment**:

- The initial `peer-profile` is sent as soon as the control channel opens,
  without waiting on geo. It must contain a valid `name`; slot 0's must also
  contain the canonical `timestamp`.
- Each peer marks `initialProfileSent` after sending its own valid initial
  payload and `initialProfileReceived` only after validating the other
  peer's required core fields.
- Phase 3 may send `channel-ready` only when the control channel is open and
  both flags are true. A missing/invalid initial profile times out in
  `pairing`, produces no record, and offers a new room.
- A later `peer-profile` enriches the stored profile with geo and any
  address fields that became available. It never reopens the barrier and
  never delays measurement.

This makes the record-critical name and slot-0 timestamp a prerequisite of
testing while keeping geo fully non-blocking.

**Sanitise what arrives.** The other end is an untrusted peer, not a
validated server relay, so the *receiving* side clamps `name` and `ua` to a
sane length, strips control characters, drops unknown or wrong-typed `geo`
keys, and ignores an `ip` that is neither a valid address nor a valid masked
form. A hostile peer cannot be stopped from lying about itself, but it must
not be able to inject a megabyte of markup into the other browser's history.

**If no profile arrives**, label that peer `Peer A`/`Peer B` by slot when
assembling a record. `name` is schema-required and no server supplies a
default, so the receiving peer provides one rather than producing an
unstorable record.

*Risk: medium — this is the phase's real trust boundary. A missed check
lands in a stored record.*

### 2.7 Showing the other peer

**`app/routes/room.tsx`**

Each peer holds the other's profile as soon as the control channel carries
it, so the room page can show who it is connected to from `paired` onward.

Note the timing: the name appears when the data channel opens, not during
`pairing`. That is the cost of not routing peer data through the server —
a second or two on a working connection.

Display the name; treat `ua`, `ip`, and `geo` as secondary detail. A peer
that withheld `ua` or `geo` renders without those rows, never as "unknown"
or an empty placeholder, which would draw attention to a deliberate choice.
A masked `ip` is shown as-is: it reads naturally as partial, and hiding it
would lose the useful signal that the two peers are on different networks.

## Risks

| Risk | Mitigation |
|---|---|
| Offer/answer glare | Deterministic offerer rule (slot 0), fixed in 2.2 |
| A candidate arriving before `setRemoteDescription` throws and silently loses a path | Queue-then-flush, specified rather than left to instinct |
| A stale waiting socket leaves client transport state behind when its slot is reclaimed | Slot reclamation exists only before `run-started`; reset all pre-run client state before accepting `peer-assigned` for the replacement (2.4) |
| Classification read too early reports `DIRECT` for a pair that later becomes relayed | Poll until the nominated pair settles; report only the settled value (2.3) |
| TURN provider access not yet available in this account | Confirm access and secrets before starting 2.1; escalate rather than guess |
| Cross-browser `getStats()` differences cause a false classification | Forced-relay plus direct test on all three browsers is this phase's criterion, not deferred |
| Geo proxy latency delays pairing | Fire-and-forget by construction; verified by blocking the proxy host |
| A privacy level is honoured in the UI but not on the wire | Every privacy check below is verified by capturing the data channel, not by reading the screen |
| `run-ended` clears the only copy of partial measurements | Post-start terminal paths await the one Phase 4 finalizer before `teardown()` |
| The testing barrier wins the race against the initial profile | `channel-ready` is forbidden until the local initial profile was sent and the remote one validated |
| A local pairing failure strands the peer and leaves the DO run joinable | Every post-`run-started`, pre-barrier failure closes signaling with app code `4401` before local teardown; Phase 1 maps the socket loss to a terminal run |

## Done when

**Credentials**

- [ ] Every live peer receives `ice-servers` at `run-started`, stamped with
      that run, and no HTTP path can obtain credentials.
- [ ] A peer that waited a long time in `waiting` still gets usable
      credentials — verified by holding slot 0 open well past a provider TTL
      before the second peer joins.
- [ ] A peer that took over a stale slot **before** any run started still
      receives `ice-servers` when the run does start.
- [ ] A credential's TTL never exceeds the room's remaining time.
- [ ] A room with less than the TTL floor remaining never calls the
      provider, and shows the expiry state instead of an ICE failure.

**Connection**

- [ ] Two tabs reach `connected`, both same-network and forced-relay.
- [ ] Control and bulk channels both arrive with the initial offer; no
      renegotiation appears in the signaling log for the whole run.
- [ ] A manual message over the control channel arrives at the other peer,
      confirming the connection is usable rather than merely reported as
      connected.
- [ ] The badge is accurate in both conditions on Chrome, Firefox, and
      Safari.
- [ ] Room page shows accurate `pairing` and `paired` states.
- [ ] A pre-measurement `run-ended` tears down immediately and writes
      nothing. A post-start `run-ended` freezes and awaits the single
      terminal finalizer before transport state is cleared.
- [ ] Forcing ICE failure while signaling is live before `channel-ready`
      calls `abortPreMeasurement` once, closes signaling with code `4401`,
      writes no record, makes the other peer receive terminal
      `run-ended: peer-left`, and makes a third join fail as terminal.
- [ ] Timing out the required initial profile has the same server-visible
      outcome as the ICE-failure test: both original peers become terminal
      and no replacement can claim the failed run.
- [ ] Concurrent ICE-failure, profile-timeout, and channel-close callbacks
      produce one signaling close, one local teardown, and one terminal UI
      reason.
- [ ] Simultaneous `run-ended`, channel-close, and ICE-failure callbacks
      join one finalization promise and produce at most one save and one
      teardown.
- [ ] Slot 0's `peer-profile` carries a `timestamp` and slot 1's does not;
      both treat it as the run timestamp defined by the schema, and slot 1
      holds it before `channel-ready`.
- [ ] Neither peer sends `channel-ready` until its initial profile was sent
      and the remote initial profile—with slot 0's timestamp—was validated.
- [ ] `run-ended` / `complete` leaves a finished result on screen with its
      badge intact — closing one tab does not reset the other.
- [ ] A room hitting hard expiry mid-pairing shows the expired state, not a
      generic connection failure.

**Profile and privacy**

- [ ] Both create and join pass through the confirm step, and a UAParser
      name appears as the editable default.
- [ ] Each peer sees the other's name from `paired` onward; a peer with no
      `ua` renders without that detail rather than showing "unknown".
- [ ] **Application profile data never crosses the signaling socket**:
      capture the WebSocket for a full run and confirm no `peer-profile`,
      name, user-agent, or geolocation appears in it. SDP/ICE candidate
      addresses are expected WebRTC signaling and must not be mistaken for
      an application-profile leak.
- [ ] **Privacy On sends no `ua` at all** — verified on the data channel —
      and the default name is neutral rather than UA-derived.
- [ ] **Privacy Anonymous sends no `ua`, a `geo` containing only
      `proxy`/`hosting`, and an already-masked `ip`** — with no locating
      field and no full address leaving the application-profile serializer.
      This does not change the network-layer disclosure described by S3.
- [ ] A peer determines its own `ip` from its srflx candidate, not the
      selected pair — confirmed by a forced-relay run reporting the peer's
      own address rather than the TURN server's.
- [ ] A hostile `peer-profile` (over-long `name`, control characters,
      unknown `geo` keys, malformed `ip`) is sanitised by the receiving peer
      and cannot reach a stored record intact.
- [ ] A peer whose profile never arrives is labelled `Peer A`/`Peer B` by
      slot by defensive result assembly, but the normal testing barrier
      times out in `pairing` and starts no measurement without the required
      initial profile.
- [ ] The geo lookup never delays ICE, and blocking the proxy host still
      lets pairing and the profile exchange complete.
- [ ] `bun run typecheck` and `bun run build` pass.

## Order

2.1 is DO-side and can start as soon as Phase 1 lands. 2.5 is pure UI and is
independent of everything else in the phase — it can be built first if
convenient, since it runs before a socket even opens.

2.2 depends on 2.1 for ICE servers and on Phase 1's socket; 2.3 on 2.2; 2.4
on 2.3. 2.6 depends on 2.2 for the control channel and on 2.5 for the
profile, and 2.7 on 2.6.

Do not start Phase 3 until the data-channel message test and the
cross-browser relay checks pass — Phase 3 reuses this connection and its
control channel.

## Review Feedback (Codex, 2026-07-29)

### Review State
- **Status: APPROVED**

### Assessment
- All review findings are resolved. Profile readiness, timestamp ownership,
  pre-measurement abort, and post-start finalization ordering are complete.
