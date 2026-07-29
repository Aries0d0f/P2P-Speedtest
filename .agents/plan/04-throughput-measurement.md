# Phase 4 — Throughput and the Result Record

> **Status**: APPROVED
> **Created**: 2026-07-29
> **Implements**: [main-plan.md](./main-plan.md) — S5 (throughput),
> S6 (the result record), S8 (`finalizing`/`result`), S10 (test parameters)
> **Builds on**: [Phase 3](./03-latency-measurement.md) — the control
> channel protocol and its `latency-ready` gate
> **Conforms to**: `schemas/p2p-speedtest-result.v1.schema.yaml`

## Goal

Run the three measurement stages — download, upload, then duplex — then have
the two peers exchange what they measured and each assemble the same result
record.

This is the phase where the results page finally has data to read.

## Scope

**In:** bulk transfer with backpressure, stage sequencing, the peer-to-peer
result exchange, record assembly and validation, and the local write.

**Out:** the `/results` page, import/export, sharing, visual polish — all
Phase 5.

> **Terminology.** "Stage" means one of the three measurement steps.
> "Phase" always means a delivery phase; this document is Phase 4. S5 uses
> the same split.

### The three stages

| Stage | Sender | Receiver | Lands in |
|---|---|---|---|
| `download` | slot 0 | slot 1 | `bandwidth.directional[]` |
| `upload` | slot 1 | slot 0 | `bandwidth.directional[]` |
| `duplex` | both | both | `bandwidth.duplex[]` |

Always in that order. The directional stages complete before duplex starts,
and each completed edge is exchanged and acknowledged before the next stage.
Both peers therefore bank the full directional pair before duplex starts,
so a run that dies partway still yields the isolated per-direction figures —
the more broadly useful of the two measurements.

## Design notes

### Slot 0 coordinates; every stage is acknowledged

**Slot 0 is the coordinator.** Only it emits `stage-prepare` and
`stage-start`. Both peers emit their own `stage-armed` and
`stage-complete` acknowledgements. The coordinator role is deterministic
because both know their slot; acknowledgements describe local readiness and
completion, so they cannot be delegated to slot 0.

Each stage has a transport barrier followed by a measurement-bank barrier:

| Step | From | Meaning |
|---|---|---|
| `stage-prepare` | coordinator | "next stage is `<id>`" |
| `stage-armed` | both peers | "counters reset, receiver ready" |
| `stage-start` | coordinator | sent only after both `stage-armed` |
| `stage-complete` | both peers | "my local send loop and receive window are done"; a sender includes its authoritative total |
| `stage-result` | each receiver | the sealed receiver-observed edge for this stage |
| `stage-result-ack` | recipient of that result | the same edge key is validated and banked |

The `stage-armed` barrier is what a settling delay cannot provide: positive
proof the receiver's counters exist and are zeroed before a single byte is
sent, rather than a hope that a second was long enough.

Every message carries `runId` and `stageId`; result messages also carry the
expected `receiverSlot`, making their edge identity
`(runId, stageId, receiverSlot)`. **Duplicates are idempotent** when their
validated content matches — a repeated `stage-start` does not restart, and a
repeated `stage-result` does not add an edge. A conflicting duplicate is a
terminal protocol failure. Messages for a stale run or non-current stage are
dropped.

A receiver seals an edge only after its receive window drained and the
remote sender's reliable `stage-complete` supplied `sentMeasuredChunks`.
It then banks that edge locally and sends `stage-result`; the recipient
validates, banks, and returns `stage-result-ack`. Slot 0 may prepare the next
stage only after both `stage-complete` messages and every required result
acknowledgement exist: one edge for each directional stage, two for duplex.
This is what makes “completed stage” mean that both peers can retain it,
including if the next stage loses a peer.

```
{ type: "stage-result", runId, stageId, receiverSlot,
  payload: { measurement:
    { bytes, durationMs, latency, jitter, chunksSeen, chunksExpected } } }

{ type: "stage-result-ack", runId, stageId, receiverSlot }
```

The recipient derives the sender from the fixed stage/slot table; neither
message may choose `from` or `to`. It checks finite bounds, usable latency,
`0 <= chunksSeen <= chunksExpected`, and `chunksExpected > 0` before
banking. Invalid content fails the run and is never acknowledged.

### Bulk chunks are framed

A settling delay cannot identify a straggler from the previous stage,
because unreliable unordered delivery means a chunk can arrive whenever it
likes. So every bulk chunk carries a small binary header:

```
runId (16B) | stageId (1B) | seq (4B) |
kind (1B: 0=ramp-up, 1=measured, 2=end)
```

The receiver counts a chunk **only** when `runId` and `stageId` match the
current stage and `kind` is `measured`. A straggler is then arithmetically
excluded rather than merely unlikely — and the same `seq` is what `loss` is
computed from, so the header earns its cost twice.

Measured sequence numbers start at 0 and advance once per measured chunk;
ramp-up chunks do not consume that sequence space. The receiver cannot infer
the total sent from the highest sequence it observed, because a lost tail
has no observed number. The authoritative denominator therefore arrives on
the reliable control channel: each sender includes
`sentMeasuredChunks = nextMeasuredSeq` in its own `stage-complete`.

The receiver computes loss only after it has that total and its bulk receive
window has drained:

```
chunksExpected = remote sentMeasuredChunks
chunksSeen = count(distinct received seq where 0 <= seq < chunksExpected)
loss = 1 - chunksSeen / chunksExpected
```

`chunksExpected` must be greater than zero. If the sender's reliable
`stage-complete` never arrives, the receiver may retain live byte counters
for diagnostics but cannot create a schema-valid edge: exact tail loss is
unknown. The stage times out, the run becomes `FAILED`, and completed
earlier-stage edges remain available.

The end marker is the header-only `kind = 2` variant, with
`seq = sentMeasuredChunks` and zero payload bytes. It is never counted as
data. The parser rejects any other kind, an end marker with a payload, or a
frame shorter than the 22-byte header. `kind = 0` and `kind = 1` require a
non-empty payload. These rules make the terminal marker an explicit wire
variant rather than an out-of-band convention.

At ~22 bytes on a 16–64 KB chunk, that cost is under 0.15%: far below the
measurement's own error.

### Live throughput is receiver-observed and mirrored

Only a receiver can report bytes that actually arrived, so live throughput
and loss use a small reliable-control message rather than the sender's
buffered-byte count:

```
{ type: "measurement-progress", runId, stageId, receiverSlot, progressSeq,
  payload: { elapsedMs, bytes, chunksSeen, highestSeqPlusOne } }
```

The receiver emits at most one update every 250 ms, plus one final update
when its window closes. Values are finite, non-negative, clamped to the
active `test-config`, and `progressSeq` increases per receiver/stage; stale
or duplicate progress is ignored. Four small messages per second is a
bounded observability cost and does not compete materially with bulk data.

Both browsers render the same receiver snapshot. The receiver uses its
local counter directly; the sender uses the latest validated
`measurement-progress` for that direction. During duplex, each browser
shows its local inbound edge and the mirrored progress for the opposite
edge.

Live throughput is `bytes * 8 / (elapsedMs / 1000)`. Live loss is explicitly
labelled **provisional** and uses gaps within the observed prefix:
`1 - chunksSeen / highestSeqPlusOne`. It cannot include an unobserved lost
tail; before any measured sequence arrives, loss is shown as unavailable
rather than dividing by zero. The exact stored loss appears only after
`stage-complete` supplies `sentMeasuredChunks` and the receiver sends the
sealed `stage-result`.

### Roles are fixed, not negotiated

The sender/receiver mapping above is fixed by slot number (S5), not
negotiated per run. Both browsers label the stages identically — never a
"yours/mine" framing that flips between screens.

Slots are positional and assigned by arrival (S2), carrying no
creator/joiner meaning; each peer learns its slot from `peer-assigned`, and
that is the mapping's only input.

The consequence that makes assembly simple: in every stage each peer
measures exactly the edge it *receives*. The stage-bank exchange replicates
that receiver-owned edge to the sender before the stage barrier clears.
After the two directional barriers, both peers therefore hold the same two
correctly-directed edges; a clean duplex barrier does the same for its pair.

### Latency and jitter come from the stage

Each edge carries the latency and jitter observed **while that stage's
transfer was running** (S5). The control channel keeps its ping/pong loop
going during bulk transfer, and each stage's samples are aggregated by
Phase 3's rules — median RTT, mean absolute consecutive difference.

Phase 3's idle aggregate is the pre-test baseline: shown live before the
stages, and the fallback for a stage that produced no samples. The duplex
stage's latency is the interesting one, since it is where bufferbloat shows
up, so it must not be overwritten with the idle figure for convenience.

### What ends a run early

Every abort path needs a concrete trigger and a status. **This table covers
aborts once measurement has begun** — the scope in which a record exists at
all (S6). The same events during `pairing` end the run without a record and
belong to Phase 2:

| Trigger | Status | `reason` |
|---|---|---|
| User presses Cancel | `CANCELED` | `user-canceled` |
| Peer's tab closes → `peer-left` (Phase 1) | `FAILED` | `peer-left` |
| `connectionState` → `failed`/`disconnected` past its grace | `FAILED` | `ice-failed` |
| Control or bulk channel closes mid-stage | `FAILED` | `channel-closed` |
| A stage handshake step times out | `FAILED` | `stage-timeout` |
| Room hard expiry (S2) | `FAILED` | `expired` |

A **Cancel action** is required on the room page during `testing`. It sends
`test-abort` with `status: CANCELED` over the reliable control channel, then
enters the same terminal finalizer as success and failure. The receiving
peer stops its send loop and enters that finalizer too. It is the only
user-facing exit that produces a record, which is why S8's `testing` state
needs it rather than leaving users to close the tab.

When the control channel is gone a peer cannot send its share at all — its
counterpart's deadline covers that case, below.

### Gate on Phase 3

The first `stage-prepare` fires only when *ICE is connected*, *Phase 3's
`latency-ready` exchange has completed on both sides*, and *this peer holds
its own finalized latency outcome*. That outcome may be `null` under Phase
3's minimum-sample rule; throughput still proceeds, and 4.3 applies the
no-usable-latency rule when deciding whether an edge can be stored.

### The result exchange

When its stages are done — or a failure ends them — each peer sends the
other **one `result-share`** over the control channel. This terminal share is
not the first delivery of a completed stage: `stage-result` already banked
each edge before the next stage. It replays the sender's receiver-owned
measurements from the frozen snapshot and carries terminal status and
connection classification. Never send it over the signaling socket: the DO
has no message type for it and would drop one (S6, Phase 1).

```
measurement = { bytes, durationMs, latency, jitter, chunksSeen, chunksExpected }

{ type: "result-share", runId,
  payload:
    | { status: "SUCCEED",
        directional: measurement,   // the edge this peer received
        duplex:      measurement,   // ditto, duplex stage
        via:         "DIRECT" | "RELAY" }

    | { status: "FAILED" | "CANCELED",
        reason:       <short machine-readable cause>,
        directional?: measurement,
        duplex?:      measurement,
        via?:         "DIRECT" | "RELAY" } }
```

Notes on the shape:

- **Every field is receiver-observed**, so one share describes one whole
  edge per group. A peer reports what it received, never what it sent —
  which is also why nothing here waits on the other side having sent first.
- **One measurement per group.** A peer receives in the download stage *or*
  the upload stage, never both, so its single `directional` measurement is
  unambiguous: the recipient knows which stage produced it from the sender's
  slot. Terminal replay is merged idempotently with the stage bank; a value
  that conflicts with the already-banked edge is a protocol failure, never
  a last-write-wins replacement.
- **No `timestamp` here.** The field is slot 0's canonical **run**
  timestamp, not a completion timestamp. It travels with the required
  initial profile during pairing (Phase 2), so both peers hold it before
  measurement and before a partial record can become necessary.
- **Loss as raw counts.** `chunksSeen` is how many distinct in-range
  measured sequence numbers arrived; `chunksExpected` is the sender's
  `sentMeasuredChunks` received through reliable `stage-complete`, never
  `highestSeen + 1`. Raw counts make the ratio auditable and include a lost
  tail.
- **`bytes`/`durationMs`, not `speed`**, for the same reason: `bytes` is the
  post-ramp-up count, `durationMs` the window it was counted over on that
  peer's clock, and `speed = bytes * 8 / (durationMs / 1000)` in bits per
  second (S6).
- **No `ip`, `protocol`, `name`, `ua`, or `geo`** — those travelled in
  `peer-profile` (Phase 2) and are not repeated.
- `reason` drives the room-page message; it is not a schema field.

### One terminal and finalization FSM

Success, cancel, failure, and `run-ended` all enter one run-scoped,
idempotent controller:

```
MEASURING
  → FINALIZING        // frozen snapshot; at most one result-share
  → LOCAL_FINALIZED   // validate/hash/save attempt resolved; result shown
  → LIFECYCLE_WAIT    // run-finished sent when signaling is still live
  → TERMINAL          // run-ended received or local grace elapsed
```

**Triggers**

- Clean completion: the duplex transport and measurement-bank barriers have
  both completed, including acknowledgement of its two `stage-result`s.
- User cancel: local `test-abort { status: "CANCELED",
  reason: "user-canceled" }`.
- Measurement failure: local `test-abort { status: "FAILED", reason }`
  whenever the control channel is still writable.
- Remote `test-abort`, Phase 3's terminal `LatencyHandoff`, transport
  failure, or Phase 1 `run-ended`.

**Ordered actions**

1. The first trigger for a `runId` creates the finalization promise. Freeze
   latency windows, the shared stage bank, any locally sealed but
   unacknowledged measurement, raw counts, peer profiles, `via`, and the
   canonical run timestamp before clearing any live state. Stop new
   ping/bulk/progress production, but keep usable control and signaling
   transport open.
2. Propagate a local cancel/failure with `test-abort` if control is writable.
   Receiving it invokes the same controller. Duplicate aborts and concurrent
   local failure callbacks join the existing promise.
3. Reduce terminal status with `FAILED > CANCELED > SUCCEED` until the local
   `result-share` is sealed, then send exactly one share and wait a bounded
   time for the peer's. A missing peer share forces this record to `FAILED`;
   no dead channel is awaited.
4. Assemble from the frozen stage bank, any local unacknowledged edge, and
   any peer share; validate, hash, and make exactly one `saveResult` attempt.
   Validation/storage failures stay visible no-write outcomes. Render the
   immutable result before lifecycle acknowledgement.
5. If signaling is still current, send Phase 1's payload-free
   `run-finished`. This does not send status, measurements, or a record and
   is not required to assemble or store locally.
6. Keep transport until `run-ended` arrives or a local lifecycle grace of
   about 8 seconds elapses—longer than Phase 1's ~5-second one-ack
   deadline—then call Phase 2's `teardown()`. A `run-ended` received
   during steps 1–4 records its reason and joins the same promise; it never
   clears the snapshot or causes a second write. `run-ended: complete`
   normally arrives after both peers reached step 5.

If the data channel is already unavailable, steps 2–3 skip peer messaging
and finalization uses the frozen stage bank plus local snapshot. If
signaling already ended, step 5 is skipped. These degraded paths still
preserve the same freeze-before-save-before-teardown order.

### Assembling the record

Each peer assembles independently from its acknowledged stage bank, local
terminal snapshot, and any share it received, following S6's deterministic
rules. There is no authority to defer to, so the algorithm must produce the
same bytes on both sides:

| Field | Source |
|---|---|
| `room` | Known to both |
| `timestamp` | Slot 0's canonical run timestamp, from its initial profile (Phase 2) |
| `status` | `SUCCEED` only if both shares say so; `CANCELED` if either does and neither says `FAILED`; else `FAILED` |
| `peers[]` | Both profiles (Phase 2), **ordered by slot** |
| `bandwidth.directional` / `.duplex` | Validated entries from the shared stage bank plus any local sealed edge from the interrupted current stage, **ordered by receiver slot**, with `speed` and exact `loss` computed and `from`/`to` derived from the fixed stage roles |
| `via` | `RELAY` if either share says so; else `DIRECT` if at least one classified; else `UNKNOWN` |

**Ordering by slot is what makes the two records identical.** Assembling in
arrival order, or by whichever peer is "me", would produce two valid records
with different bytes and therefore different checksums for one test.

**Validate before hashing** via `validateData` (4.3b): every edge endpoint
is a known peer, `from !== to`, a two-edge group is a proper reverse pair,
and `data.room` is this room. A failure means a real bug — store nothing and
surface an error rather than persisting something incoherent.

**Edges with no usable latency are omitted, never zeroed.** Phase 3 can
finalize a `null` aggregate, and a stage can produce no samples of its own.
With neither, that measurement yields **no edge**: the schema requires
numeric `latency`/`jitter`, and `0` would read as a flawless connection. The
group is then incomplete, so the run cannot be `SUCCEED`.

### When a share never arrives

No server is involved, so the only thing a peer can wait for is its
counterpart. Give that a short deadline — ~5s after its own stages end —
then assemble with the frozen stage bank and whatever sealed local
current-stage measurement it has:

- **Both shares exchanged** → two complete records, byte-identical.
- **No share received** → a `FAILED` record holding every acknowledged
  stage-bank edge plus this peer's own sealed current-stage measurement,
  with **both** `peers[]` entries: its own, and the other's under whatever
  profile arrived, or its peer id with a fallback name if none did (S6).
  If duplex had started, the bank already contains the full directional
  pair.
- **Neither peer got the other's** → both retain the same acknowledged
  completed stages, but may differ in a locally sealed, unacknowledged
  current-stage edge. Different checksums are two honest accounts of a test
  that ended badly, not corruption (S6).

A peer is never blocked on a server to assemble or store and never retries a
result against one. `run-finished` only coordinates room teardown after the
local finalization attempt.

### Server-issued test parameters (S10)

The client does not choose how long or how much it transfers. The DO sends
**`test-config`** — `{ maxDurationMs, maxBytes, chunkBytes }` — to each
socket immediately after `peer-assigned` (Phase 1 fixed that trigger), and
the send loop runs within those numbers rather than a client-side constant.

Phase 1 snapshots the value once at room claim and replays that stored value
on every accept, so both peers—and any pre-run replacement—receive the same
parameters even across a deployment. The same parameters govern every
stage, so directional and duplex figures stay comparable; a duplex number
measured over a different window would not be.

**Nothing verifies compliance, and this plan must not imply otherwise.** The
DO is not in the data path and never sees a measurement, since peers
exchange those directly — so there is no server-side check to make. A
modified client can transfer whatever it likes.

What the parameters buy is that the *shape* of a test is decided by the
service rather than a constant in the client: both peers use the same
duration and chunk size, so their halves are comparable and so are results
between runs. Worth having on its own. Not an abuse control — the
relay-cost argument rests on S4's short-lived credential.

A receiving peer may still sanity-check a share against the config it was
issued: a `durationMs` wildly beyond `maxDurationMs` says the other side is
not running this protocol. That is defensive parsing, not enforcement.

## Work

### 4.1 Bulk transfer

**`app/lib/throughput.ts`** (new)

The `bulk` channel already exists — Phase 2 creates it with the initial
offer, `{ ordered: false, maxRetransmits: 0 }` (S5). One channel carries
every stage in both directions; the frame header says which stage a chunk
belongs to, so a second channel would add negotiation surface for nothing.
The duplex stage sends both ways over it at once.

**Send loop:** chunks of `chunkBytes`, running for at most `maxDurationMs` /
`maxBytes` after a discarded ramp-up, respecting `bufferedAmountLowThreshold`
and the `bufferedamountlow` event. Those numbers come from `test-config`,
not from client-side constants. Sensible values for the DO to issue: 16–64 KB
chunks, 5–10s duration.

**The frame header is mandatory**, not optional: every chunk carries
`runId`, `stageId`, `seq`, and the explicit
`ramp-up`/`measured`/`end` kind byte. `seq` is what excludes stragglers, and
`loss` falls out of it for free. Centralize `encodeBulkFrame` and
`parseBulkFrame`; reject truncated frames, unknown kinds, empty data
variants, and non-empty end markers.

**Receiver side:** count only chunks matching the current run and stage with
the `measured` kind. Track distinct measured sequence numbers and the
cumulative post-ramp-up byte count. A duplicate `seq` counts once. After the
reliable sender `stage-complete` supplies `sentMeasuredChunks`, discard
out-of-range sequence numbers and finalize
`chunksSeen`/`chunksExpected`. Those raw values—not `highestSeen + 1`—are
what the sealed result carries. Expose the local receiver snapshot and send
bounded `measurement-progress` at most every 250 ms so the remote sender
renders that same receiver-observed throughput and provisional loss. Retain
the elapsed window; raw bytes and duration, not the displayed rate, feed the
sealed stage result.

**Ending the receive window** needs its own rule, because the reliable
control channel and the unreliable bulk channel race: a sender's
`stage-complete` routinely overtakes its own last chunks, and closing on
that message would discard the tail of the transfer being measured.

- The sender emits the explicit **end variant** — `kind = 2`,
  `seq = sentMeasuredChunks`, header only, with the same `runId`/`stageId` —
  after its last data chunk.
- The receiver closes on the end marker, **or** after a quiet period with no
  matching chunk (~500 ms), **or** at its own hard deadline derived from
  `maxDurationMs` — whichever comes first. The marker is itself unreliable,
  so it cannot be the only path.
- The window ends at the **last counted chunk's arrival**, not at whichever
  of those three fired: otherwise the quiet period inflates `durationMs` and
  deflates the rate.

A peer sends `stage-complete` only once **both** its local transport roles
are done — send loop finished and receive window closed. A peer with a
sender role includes its authoritative `sentMeasuredChunks`; a receiver-only
peer omits that field. In duplex both peers include it. A receiver does not
seal or send `stage-result` until it has both the remote total and a drained
receive window.

*Risk: high — backpressure is the most failure-prone code in the project.
Get it wrong and results are either meaningless, because unbounded buffering
hides the real rate, or the channel stalls outright.*

### 4.2 Stage sequencing

**`app/lib/control-channel.ts`** (extends Phase 3's `latency.ts`)

Implement the transport and bank barriers using Phase 3's reserved message
names, run three times in order: download, upload, duplex.

The gate is Phase 3's `latency-ready` exchange completing, after which the
coordinator sends the first `stage-prepare`. The third stage moves the room
page into `finalizing`, not straight to `result`, only after its transport
barrier and both stage-result acknowledgements complete.

Every message carries `runId` and `stageId`; result/progress messages also
carry `receiverSlot`. Matching duplicates are ignored rather than
reprocessed, conflicting result duplicates fail the run, and messages for a
non-current stage are dropped.

The duplex stage differs structurally: **both peers run the send loop and
the receive counter at once**, so a peer is no longer either sender or
receiver but both. Keep the two roles as separate objects rather than a mode
flag — duplex is then "start both", not a third code path.

A settling gap between stages is worth having so buffers drain, but it is
not what protects the measurement: the frame header and the `stage-armed`
barrier do that. Do not treat the gap as a correctness mechanism.

For every sealed inbound edge, send `stage-result`, bank it locally, and wait
for `stage-result-ack`. The recipient validates fixed role ownership and raw
counts before banking and acknowledging. Slot 0 cannot prepare the next
stage until all transport acknowledgements and required bank
acknowledgements are present. The two directional edges are consequently in
both peers' banks before duplex begins.

Progress is not a bank and never enters a result record. Route the latest
validated local or remote `measurement-progress` snapshot into the room
reducer under the fixed edge identity, render its Mbps and explicitly
provisional loss on both screens, and discard it when its stage seals or the
run changes.

Every handshake step needs an explicit timeout that drops into a `testing`
error sub-state rather than hanging silently. A timeout during duplex still
finalizes with the directional pair already acknowledged and banked — never
discard completed stages because a later one failed. A missing or invalid
`stage-result`/ack is such a timeout; it does not promote a transport-only
completion into a banked edge.

If a sender's `stage-complete` and therefore `sentMeasuredChunks` never
arrives, that receive side is incomplete and produces no edge. The timeout
enters the terminal FSM with `FAILED`; it does not substitute
`highestSeen + 1`.

*Risk: medium — a small distributed state machine across two peers.*

### 4.3 Result module and shared hash

**`app/lib/result-hash.ts`** (new)

`computeResultHash(data)` — SHA-256 hex over `canonicalize(data)` via
`crypto.subtle`.

`canonicalize` implements **RFC 8785 (JCS)**, not "RFC 8785-shaped", which
would leave the hard parts undefined. Key sorting is the easy half; the half
that breaks interoperability is serialization:

- **Keys** sorted by UTF-16 code unit, as JCS specifies.
- **Numbers** per ECMAScript `Number::toString`, which JCS adopts: integers
  plain, no `+`, no trailing `.0`, exponent form only outside 1e21/1e-7.
  `speed` is a large integer and `latency` a decimal, so both paths are live.
- **Strings** with JSON's minimal escaping — `"`, `\`, and control
  characters only; no escaping of non-ASCII.
- Arrays keep order. No whitespace anywhere.

**Ship conformance vectors** as fixtures: an integer `speed`, a fractional
`latency`, a peer id, a `geo` with non-ASCII text, and an object built with
two different key insertion orders. Assert byte-identical output. Without
them, a divergence between two browsers' serializers shows up as two peers
disagreeing about a test they both ran correctly.

**One implementation, used everywhere.** Each peer calls it when assembling;
Phase 5 calls it for import verification. A hash written twice is one that
will eventually disagree with itself.

It is a **checksum, not a signature** (S6). Name and comment it that way so
nobody later builds a trust decision on it.

### 4.3b Validation foundation

**`app/lib/result-validate.ts`** (new) + schema tooling

Each peer validates assembled `data` **before** hashing it, so the machinery
lives in this phase; Phase 5 consumes it rather than creating it. Layer it
by what each consumer can actually check:

- **`validateData(data)`** — schema validation of `data` plus the semantic
  invariants over it: `data.room` matches, exactly two peer ids are present
  and unique, every edge endpoint is a known peer with `from !== to`, a
  two-edge group is a proper reverse pair, and `SUCCEED` implies both groups
  are full. **This is what an assembling peer calls**; it cannot check more,
  since at that moment there is no `metadata` and no hash yet.
- **`validateEnvelope(entry)`** — the full record: `validateData` plus
  `apiVersion`/`kind`, `metadata.id === data.room`, `metadata.peer-id`
  appearing exactly once in `data.peers`, and the checksum. **Phase 5's
  import calls this**; an assembling peer cannot, since it is building
  `metadata` rather than checking it.

Tooling, needed here for the same reason: **Ajv** (`ajv/dist/2020`) with
**`ajv-formats`** for `uuid`, `ipv4`, `ipv6`, `date-time` — without which
those formats are silently ignored and the checks do nothing. The YAML
schema is **converted to JSON at build time** so neither the Worker nor the
browser parses YAML at runtime; the YAML file stays the source of truth.

Fixtures live here too, covering every schema conditional: `SUCCEED`
complete, each non-`SUCCEED` status with partial groups, `via: UNKNOWN`, and
one violation per format.

**`app/lib/results.ts`** (new)

The `P2PSpeedtestResult` type, generated from or hand-mirrored against the
schema (either is fine; the schema stays the source of truth), plus
`buildMetadata(roomId, peerId, hash)`. No `generateId` — identity is
`metadata.peer-id` + `data.room` (S7).

Result history uses **IndexedDB**, not one shared `localStorage` array.
Create database `p2p-speedtest` with a `results` object store and no inline
key path. Store each envelope under the out-of-line compound IndexedDB key
`[data.room, metadata["peer-id"]]`. This keeps each record independently
keyed and gives writes a real cross-document transaction.

**Async `saveResult(result)` owns deduplication**, not its callers. In one
`readwrite` transaction it calls `add(result, [room, peerId])`:

- success commits the new record;
- an `add` request `ConstraintError` means that identity already exists; its
  handler prevents that expected request error from aborting the transaction
  and reports “deduplicated” without changing the existing first write;
- no code calls `put`, and import reuses this exact function (Phase 5).

IndexedDB serializes competing transactions across same-origin tabs. Two
tabs saving different peer identities cannot overwrite a shared array, and
two tabs racing the same identity leave whichever `add` commits first. A
route-level flag, localStorage read/modify/write, or in-memory mutex cannot
provide those guarantees across documents.

Two failure modes it handles rather than throwing into a render:

- **Database open/transaction failure** — do not delete or recreate the
  database automatically. Return a structured storage error and leave all
  existing object-store data untouched.
- **`QuotaExceededError`** — abort the transaction and report the write as
  failed so the room page can say the result could not be saved, rather than
  losing it silently.

`listResults` validates entries when reading. A malformed legacy/imported
entry is skipped with a visible warning and left untouched for manual
recovery; a bad row never causes the store to be wiped.

*Risk: low, but verify `canonicalize` is genuinely deterministic — serialize
the same object built with two different key insertion orders and confirm
identical output. Both peers and Phase 5's import path rest on this.*

### 4.4 Exchange, assemble, persist

**`app/lib/control-channel.ts`** — implement the terminal FSM above.
`test-abort` propagates cancel/failure; the duplex completion barrier,
Phase 3 terminal handoff, transport callbacks, and `run-ended` all invoke
the same run-scoped controller. It sends at most one `result-share`,
populating `directional`, `duplex`, and `via` only where this peer genuinely
has them. No `timestamp`: the canonical run timestamp travelled with the
initial profile during pairing.

Wait briefly (~5s) for the other side's share only after sending this
peer's. **Send first, then wait** — never gate sending on having received,
or two peers each waiting politely would deadlock.

**`app/lib/results.ts`** — assemble per "Assembling the record": merge the
stage bank and terminal inputs by edge identity, order by receiver slot,
compute `speed` and exact `loss`, derive `from`/`to`, run `validateData`,
compute the checksum, wrap in this peer's own `metadata`, and await
`saveResult`.

**Every surviving peer on a path that reached measurement attempts to store
a record**, including the one where no share arrives. There is nothing to
retry: the peer already holds everything it personally measured, and no
server has to agree before it can keep it. A run that ends before
measurement stores nothing and reaches a terminal state offering a new room
(S2, S6). Validation or browser-storage failures remain explicit no-write
error paths.

**`app/routes/room.tsx`** — render the assembled record. Dedup lives in
transactional `saveResult`; the page needs no flag of its own. Feed both
local receiver counters and remote `measurement-progress` through one
fixed-edge UI model so both browsers show receiver-observed live Mbps and
provisional loss. After the render and save attempt resolve, send
payload-free `run-finished` and await
`run-ended`/local lifecycle grace before final transport teardown.

*Risk: medium, and it has moved. The old failure mode was a round-trip to a
server; the new one is two peers silently disagreeing. Test by making one
side's share arrive late or not at all, and confirm both records are
individually valid and honestly partial.*

## Risks

| Risk | Mitigation |
|---|---|
| Unbounded `bufferedAmount` inflates the measured rate | Event-driven send loop against a real threshold, verified against actual numbers rather than "no errors thrown" |
| Cross-browser data-channel buffering differences skew results | Cross-browser manual pass at the end of this phase |
| `stage-complete` overtakes the unordered tail and truncates the measurement | End marker plus quiet-drain, with the window measured to the last counted chunk |
| Lost final chunks disappear from the loss denominator | Sender total travels reliably in `stage-complete`; no total means no edge, never `highestSeen + 1` |
| A late chunk from the previous stage inflates the next stage's count | Frame header carries `runId`/`stageId`/`kind`; non-matching chunks are not counted |
| A sender starts before the receiver's counters are armed | `stage-armed` barrier from both peers gates every `stage-start` |
| A dropped handshake leaves the peers in inconsistent sub-states | Explicit timeout per step into a `testing` error sub-state |
| A failure in the duplex stage discards good directional data | Each directional edge is acknowledged into both peers' stage banks before duplex can start |
| Duplex measures the CPU rather than the link on fast connections | Identical parameters across stages keep the comparison fair; an implausibly low duplex figure prompts a CPU check, not a discarded run (S5) |
| **Two peers assemble different bytes for one test** | Deterministic assembly — slot ordering everywhere and a single timestamp author (S6) — covered by a byte-comparison test |
| A `null` latency silently becomes `0` and reads as a perfect link | No usable latency means no edge; the group is incomplete and the run is not `SUCCEED` |
| Two serializers disagree and every import fails a checksum | One shared RFC 8785 implementation with conformance vectors |
| Same-origin tabs lose or overwrite each other's history | IndexedDB compound keys plus transactional `add` make distinct identities independent and same-identity writes first-commit-wins |
| Live sender-side bytes masquerade as received throughput | Only receiver counters drive the UI; bounded progress mirrors them to the sender and labels prefix loss provisional |
| An ambiguous terminal flag is parsed as data | The frame kind byte has a dedicated `end = 2` header-only variant and strict parser tests |
| A late share reaches state from another room/run | Terminal teardown clears partial state, and every share is checked against the current `runId` |
| `run-ended` races finalization and clears the snapshot | Every terminal event joins one controller; save settles before `teardown()` |
| Cancel stops only one peer | `test-abort` propagates over control and enters the identical finalizer on receipt |
| Application profile or result data leaks through the signaling socket | The DO has no message type that carries either and drops unknown types (Phase 1); covered by a capture test |
| A modified client runs unbounded transfers on relayed connections | S4's short credential TTL is the only actual bound; `test-config` fixes the shape of an honest test and nothing more (S10) |

## Done when

**Stages and transfer**

- [ ] The bulk channel uses `ordered: false, maxRetransmits: 0`, verified in
      review and via `chrome://webrtc-internals`.
- [ ] All three stages run in order, each with live Mbps, roles swapped
      between the first two, and both peers sending and receiving in the
      third.
- [ ] Roles follow slot number, verified by a run where the invitee's tab
      connected first.
- [ ] The first `stage-prepare` never fires before Phase 3's `latency-ready`
      completes on both peers.
- [ ] Every stage is gated by `stage-armed` from both peers; a duplicated
      `stage-start` does not restart a running stage.
- [ ] Only slot 0 emits `stage-prepare`/`stage-start`; both peers emit their
      own `stage-armed`/`stage-complete`.
- [ ] Each receiver sends one validated `stage-result` per inbound edge and
      its recipient sends `stage-result-ack`; slot 0 does not prepare the
      next stage until every required edge is banked on both peers.
- [ ] After upload and before duplex, both browsers' stage banks contain the
      same two directional edges. Closing either browser at that boundary
      cannot remove the pair from the survivor.
- [ ] A bulk chunk carrying a previous `stageId` or a stale `runId` is not
      counted — verified by injecting one at the start of a stage.
- [ ] Ramp-up chunks are excluded by `kind = 0`, measured chunks use
      `kind = 1`, and the header-only end marker is `kind = 2`; encode/decode
      round trips cover all three variants, and parser tests reject an
      unknown kind, truncated header, empty data frame, and end marker with
      payload.
- [ ] A stage's tail chunks are counted: the window closes on the end marker
      or quiet period, and `durationMs` is measured to the last counted
      chunk rather than to the marker.
- [ ] A peer sends `stage-complete` only after both its send loop and its
      receive window have finished — verified in the duplex stage — and
      every sender includes its exact `sentMeasuredChunks`.
- [ ] Dropping the last N measured chunks still counts all N in
      `chunksExpected` and raises loss accordingly; the denominator comes
      from reliable `stage-complete`.
- [ ] If the sender's reliable total never arrives, that stage produces no
      edge, the result is `FAILED`, and earlier complete edges remain.
- [ ] In each directional stage, both screens show the receiver's live Mbps
      and explicitly provisional prefix loss; the sender obtains them only
      from `measurement-progress`, never from sent-byte counters.
- [ ] Progress is bounded to four messages per second per receiver/stage
      plus one final update, and stale `runId`, `stageId`, or `progressSeq`
      values do not change the UI.
- [ ] In duplex, each screen renders both receiver-observed directions—one
      local and one mirrored—and replaces provisional loss with the exact
      stage-result value after sealing.
- [ ] `bufferedAmount` stays bounded through a real run.
- [ ] `test-config` arrives on every socket right after `peer-assigned`, and
      a withheld or malformed one prevents the test from starting rather
      than falling back to built-in defaults.

**The exchange and the record**

- [ ] `result-share` travels over the control channel only. Capture the
      signaling socket for a full run and confirm no measurement,
      application-profile field, or result appears in it. SDP/ICE candidate
      addresses are expected protocol traffic.
- [ ] A complete run stores two `directional` and two `duplex` edges, each a
      proper reverse pair.
- [ ] **Both peers' stored `data` are byte-identical**, and so are their
      checksums. Read and diff the two browsers' IndexedDB rows — this is
      the real test of deterministic assembly.
- [ ] Slot ordering holds regardless of arrival order: delay one share and
      confirm the assembled bytes are unchanged.
- [ ] `timestamp` comes from slot 0 in both records, not from each peer's
      own clock; it is the schema-defined run timestamp captured before
      measurement, including when the result exchange never completes.
- [ ] A partial record carries **both** `peers[]` entries, so every edge
      endpoint resolves and `validateData` passes.
- [ ] Stored `speed` is computed from `bytes`/`durationMs` in bits per
      second — check one real run against the raw byte count by hand, so a
      factor-of-8 error cannot pass as plausible.
- [ ] Every edge carries a `loss` between 0 and 1 computed from the raw
      counts — verified against a run with deliberately dropped chunks, and
      confirmed to stay at 0 on a clean local run.
- [ ] A duplicate sequence number does not push `loss` below 0.
- [ ] Edge `from`/`to` are derived from the sender's slot: a share with a
      forged direction cannot flip an edge.
- [ ] Duplex edges carry latency/jitter measured **during** the duplex
      stage, not Phase 3's idle figure copied across.
- [ ] A stage with no usable latency produces **no edge** rather than one
      with `latency: 0`, and the run finalizes non-`SUCCEED`.
- [ ] `validateData` rejects a broken assembled `data` before hashing, and
      nothing is stored when it fails.
- [ ] The RFC 8785 conformance vectors pass, including a fractional
      `latency`, a large integer `speed`, and non-ASCII `geo`.

**Partial and failed runs**

- [ ] A share that never arrives leaves that peer storing acknowledged bank
      entries plus any local sealed current-stage edge as a `FAILED` record,
      with the other peer under its fallback name — valid and visibly
      partial.
- [ ] Neither peer receiving the other's share leaves two individually valid
      records with differing checksums, and neither browser reports an error
      beyond "incomplete".
- [ ] Killing the run during the duplex stage still stores a `FAILED` record
      retaining both directional edges.
- [ ] A run ending during `pairing` — before any stage was armed — writes no
      record in either browser, and the terminal page offers a new room.
- [ ] Cancel during `testing` produces a `CANCELED` record with the stages
      completed so far in both browsers: one `test-abort` reaches the peer,
      each sends one result share, and each performs one save.
- [ ] Clean completion follows the full order in both tabs: freeze → exchange
      → validate/hash/save attempt → render → payload-free `run-finished`;
      only then does the DO emit the single `run-ended: complete`.
- [ ] `run-ended` racing a local channel/ICE failure during finalization
      produces one frozen snapshot, at most one share, one save attempt, and
      one teardown.
- [ ] A Phase 3 terminal handoff after latency sampling but before the first
      throughput stage stores a schema-valid `FAILED` record with no invented
      bandwidth edge.
- [ ] A share injected with a stale `runId` is ignored.
- [ ] `saveResult` is idempotent on its own: concurrent calls for the same
      identity from two tabs commit one first-write-wins IndexedDB row.
- [ ] Two tabs simultaneously saving different peer identities for the same
      room leave both rows present; no shared-array read/modify/write exists.
- [ ] A malformed row or IndexedDB open/transaction failure surfaces a
      warning and never triggers automatic database deletion or recreation.
- [ ] A simulated `QuotaExceededError` surfaces as a visible "couldn't save"
      state, not a silent loss.
- [ ] Cross-browser manual pass (Chrome, Firefox, Safari) completed.
- [ ] `bun run typecheck` and `bun run build` pass.

## Order

4.1 and 4.3 are independent and can run in parallel — 4.3 is pure. 4.2
depends on 4.1 and Phase 3's channel. 4.4 depends on 4.2 and 4.3; its client
code can be written against the message contract before the other side is
finished, but end-to-end testing needs both.

Do not start Phase 5 until a full record reliably lands in IndexedDB
and the partial-record paths above behave — Phase 5's list, detail, import,
and export are all built on that exact contract.

## Review Feedback (Codex, 2026-07-29)

### Review State
- **Status: APPROVED**

### Assessment
- All review findings are resolved. Loss, stage banking, live metrics,
  terminal handling, frame parsing, and transactional persistence are
  executable and covered by acceptance checks.
