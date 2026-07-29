# Phase 3 — Latency Measurement

> **Status**: APPROVED
> **Created**: 2026-07-29
> **Implements**: [main-plan.md](./main-plan.md) — S5 (latency),
> S8 (`testing` state, first use)
> **Builds on**: [Phase 2](./02-webrtc-connection.md) — the connection and
> its control channel

## Goal

The smallest real measurement: ping/pong over the control channel producing
RTT and jitter, live on both screens.

This validates the whole data-channel measurement approach — timestamps,
framing, live display — before the higher-stakes throughput work. It also
defines the control-channel protocol that Phase 4 extends.

## Design notes

### The channel, and who owns what

Phase 2 creates the `control` channel with the initial offer; this phase
owns the protocol that runs over it and adds no channel of its own. That
split exists because a channel added after connection would force an SDP
renegotiation nothing implements, and Phase 2 already needs the channel for
the profile exchange.

**The channel is ready for measurement** only once each side has seen its
own `open` event, sent its required initial profile, validated the other's
initial profile, and received the other's `channel-ready`. Nothing is
measured before that: a peer pinging into a half-open channel loses its
first samples and skews the median, while starting without the profile would
leave Phase 4 unable to assemble a valid partial record.

One channel per run. Before the measurement barrier, `run-ended` closes it
with no record. After the barrier, `run-ended` first freezes the current
latency state and hands that snapshot to Phase 4's terminal accumulator;
live state is reset only after the terminal finalizer has copied it. The
room is then terminal, and a new room builds a new connection and channel.

### Every message is scoped to a run and a sample

```
{ runId, type, seq?, payload }
```

`runId` is Phase 1's, checked on receipt and dropped if stale. `seq` is a
monotonic per-sender ping counter that `pong` echoes back.

Both matter. A pong from a defunct connection could otherwise satisfy live
measurement state, and timestamps alone cannot distinguish a late reply from
a fresh one — two pings 200 ms apart on a flaky link produce
indistinguishable round-trip timing. Match every pong to its ping by `seq`,
ignore unmatched or duplicate replies, and discard any pong for a `seq`
already retired by timeout.

### Symmetric measurement

Both peers run the identical protocol concurrently: each sends its own
periodic pings and echoes pongs for the other's, computing RTT purely from
its own round trips.

There is no "who samples" role and no metrics-sharing message for the idle
latency baseline — both sides have live numbers because both are measuring.
Phase 4 does add bounded receiver-progress messages for throughput, whose
sender/receiver roles are asymmetric. Clock skew is still structurally
impossible to mistake for latency: every RTT uses one machine's clock for
both timestamps, and timestamps are never compared across peers.

### Bounded sampling

"10 samples" alone is not implementable on a lossy link, where a peer could
wait forever for a tenth pong. The window is bounded by both a count and a
clock:

| Parameter | Value | Why |
|---|---|---|
| Send cadence | one ping / 200 ms | 10 samples in ~2s |
| Per-ping timeout | 2 s | after which that `seq` is retired as lost |
| Window deadline | 5 s wall clock | hard stop regardless of replies |
| Target samples | 10 | normal completion |
| Minimum samples | 3 | fewest yielding a meaningful median and two differences for jitter |

The window closes on 10 matched samples or the deadline, whichever comes
first:

- **≥ 3 samples** → aggregate normally, recording how many were used.
- **< 3 samples** → no usable latency. `latency-ready` carries `null`, the
  run continues to throughput, and each stage measures its own latency
  anyway (S5). A link too lossy to return three pongs in five seconds is
  worth reporting on, not worth blocking.

A pong arriving after its `seq` was retired is discarded, not folded back
in: a 3-second round trip counted as a sample would distort the median far
more than the missing value does.

**What `null` means downstream.** The schema requires numeric `latency` and
`jitter` on every stored edge, so `null` can never be written — and must
never be quietly coerced to `0`, which would read as a perfect connection.
Phase 4 implements the rule: a stage with no usable aggregate of its own and
no usable idle baseline produces **no edge**, leaving its group incomplete
so the run cannot be `SUCCEED` (S6). A measurement that could not be taken
is absent, never zero.

### Aggregates

Over the closed window:

- **`rttMs`** — the median RTT.
- **`jitterMs`** — the mean absolute difference between consecutive RTTs.

Mean-absolute-difference is chosen over variance because it is the
definition consumer speedtest tools use, so the number matches what users
expect. Document that choice in code.

**This aggregation is reused per stage in Phase 4.** What this phase
measures is the *idle baseline* — latency with nothing else on the wire.
Phase 4 keeps the same loop running during each transfer stage and
aggregates by these same two rules, so every stored edge carries latency
measured under its own load (S5). Expose the aggregator as a reusable
function over a sample window, not a one-shot that assumes it runs once.

### Starting: an automatic two-peer barrier

S8 calls `paired` "ready to test", which leaves the trigger unstated. It is
automatic, with a two-sided barrier — no button:

1. Each peer, on reaching `paired` with the control channel open, sends
   its required initial `peer-profile`.
2. After sending its own initial profile and validating the other's core
   profile, each peer sends `channel-ready`. Slot 1 must have validated slot
   0's canonical run timestamp before it can do so.
3. Having sent its own `channel-ready` and received the other's, each peer
   starts sampling and moves to `testing`.

Both sides decide independently from the same two facts, so no coordinator
is needed and neither can start into a channel the other has not opened.

Automatic rather than manual because the test is the entire purpose of the
page; a "Start" button between pairing and measuring answers a question
nobody asked. Cancellation covers the user who wants out (Phase 4).

### The `latency-ready` handshake

Each peer finalizes its own aggregate, then sends `latency-ready` carrying
its `{ rttMs, jitterMs }` — or `null`. A peer considers the latency
sub-phase complete only when it has both finalized locally and received the
other's `latency-ready`.

This is the gate Phase 4 waits on before starting throughput. It does not
require the two numbers to match: they are independent measurements of the
same path, expected to be close, not identical.

Add a timeout on the wait. If the peer's `latency-ready` never arrives, or
the channel / run ends after sampling began, freeze the local sample window
and take the typed terminal handoff below rather than entering an
unspecified error path.

### Typed handoff to terminal finalization

Phase 3 exposes one immutable handoff consumed by Phase 4:

```
type LatencyHandoff =
  | { kind: "ready"; baseline: Aggregate | null }
  | { kind: "terminal";
      reason: "latency-ready-timeout" | "control-closed" | "run-ended";
      baseline: Aggregate | null;
      sampleCount: number };
```

`freezeForTerminal(reason)` is idempotent and ordered:

1. Stop new pings and retire timers without clearing the sample array.
2. Snapshot the samples already received.
3. Aggregate that snapshot when it has at least three samples; otherwise
   preserve `baseline: null` and its real `sampleCount`.
4. Deliver exactly one `terminal` handoff to Phase 4's run-scoped result
   accumulator.
5. Clear the live window only after the terminal finalizer confirms it
   copied the snapshot.

The measurement boundary is the resolved `channel-ready` barrier: once
sampling begins, a timeout or `run-ended` produces a `FAILED` partial-record
attempt even if no throughput edge exists yet. Before that barrier, Phase
2's pre-measurement path writes nothing.

## Work

### 3.1 Protocol and ping/pong

**`app/lib/latency.ts`** (new)

The channel already exists. Define the tagged union that runs over it:

```
channel-ready | ping | pong | latency-ready                  // this phase
stage-prepare | stage-armed | stage-start | stage-complete   // reserved, Phase 4
measurement-progress | stage-result | stage-result-ack      // reserved, Phase 4
peer-profile                                                 // Phase 2
test-abort | result-share                                    // reserved, Phase 4
```

Ship exactly these names. A union that reserved messages Phase 4 does not
use would have to be changed by the phase it was meant to serve.

Every message carries `runId`; `ping` and `pong` also carry `seq`.

Both peers run the same loop: send `ping` with a local timestamp and the
next `seq`, echo `pong` with both on receipt, and compute RTT locally when
one's own pong returns matched by `seq`.

Expose `freezeForTerminal(reason)` separately from `reset()`. Post-start
`run-ended` calls the former, and Phase 4 calls `reset()` only after copying
the frozen handoff. Pre-measurement teardown may reset immediately because
no result boundary was crossed.

*Risk: low-medium. The measurement is the simplest in the project, but the
open-gate and `seq` matching are where the subtle bugs live: a half-open
channel or an unmatched pong produces plausible-looking wrong numbers.*

### 3.2 RTT, jitter, and finalization

**`app/lib/latency.ts`**

Maintain a rolling window of recent RTTs and expose live RTT and jitter as
samples arrive. Retire timed-out `seq` values so a stalled ping cannot hold
the window open. Close on 10 matched samples or the deadline; aggregate if
at least 3 exist, otherwise finalize `null`. Send `latency-ready` and
resolve once the peer's has also arrived. On peer-ready timeout,
control-close, or post-start `run-ended`, call `freezeForTerminal` and hand
the typed failure to Phase 4 rather than rejecting into an unowned error
path.

Keep the aggregator a pure function over a sample array — Phase 4 calls it
once per stage.

### 3.3 Live display

**`app/routes/room.tsx`**

Enter `testing` once the two-sided `channel-ready` barrier resolves, not on
`paired` alone. Show live-updating RTT and jitter, and leave the latency
sub-phase when the window closes and the handshake resolves.

Show a "couldn't measure latency" note rather than a zero when the aggregate
is `null`.

## Risks

| Risk | Mitigation |
|---|---|
| Clock skew read as latency asymmetry | RTT is always computed by the peer that sent the ping, from its own clock only |
| Jitter definition doesn't match user expectations | Documented in code and in the schema field description; revisit only on feedback |
| Measuring into a half-open channel skews the first samples | Two-sided `channel-ready` barrier before any ping |
| A late pong from defunct transport satisfies live measurement state | `runId` on every message plus `seq` matching; unmatched and retired replies discarded |
| Waiting forever for a tenth sample on a lossy link | Wall-clock deadline and a minimum-sample rule, with a defined `null` outcome |
| A `null` aggregate silently becomes `0` and reads as a perfect link | No usable latency means no edge downstream (Phase 4), never a zero |
| Peer's `latency-ready` never arrives | Explicit timeout freezes a typed `LatencyHandoff` for Phase 4; it neither hangs nor discards the partial input |
| `run-ended` clears live samples before the result path sees them | `freezeForTerminal` snapshots first; `reset()` waits for the accumulator to copy it |

## Done when

- [ ] Exactly one control channel exists per run, and this phase adds none
      of its own.
- [ ] Sampling starts only after both sides exchange `channel-ready` — a
      peer that opens early sends no ping until its initial profile was sent,
      the remote initial profile was validated, and the barrier resolves.
- [ ] RTT is correct, sanity-checked against `chrome://webrtc-internals`.
- [ ] Jitter is computed and displayed alongside RTT.
- [ ] Both peers see live-updating numbers.
- [ ] Both peers finalize and exchange `latency-ready`, and their values are
      close on a stable connection — confirming both measure the same path.
- [ ] Neither peer proceeds toward Phase 4's first stage before both its own
      finalization and the peer's `latency-ready`.
- [ ] With ~50% simulated packet loss, the window still closes on its
      deadline and aggregates from the samples that returned.
- [ ] With fewer than 3 returned samples, `latency-ready` carries `null`,
      the UI says so rather than showing 0, and the run still proceeds.
- [ ] A pong replayed with a stale `runId`, a duplicate `seq`, or a retired
      `seq` is ignored and does not enter the window.
- [ ] A missing peer `latency-ready`, a control close, and a post-start
      `run-ended` each produce exactly one typed terminal handoff containing
      the frozen aggregate (or honest `null`) and sample count.
- [ ] A latency failure after the `channel-ready` barrier reaches Phase 4's
      finalizer and attempts a `FAILED` partial record even when no
      throughput edge exists.
- [ ] The tagged control-message union reserves Phase 4's bounded
      `measurement-progress`, stage-boundary `stage-result`, and
      `stage-result-ack` messages; unknown message types remain rejected.
- [ ] Post-start `run-ended` cannot clear the window, `seq` table, or
      aggregate until the accumulator copies the snapshot; afterward a new
      room starts clean.
- [ ] `bun run typecheck` and `bun run build` pass.

## Order

Single-threaded: 3.1 → 3.2 → 3.3, small enough for one session.

Do not start Phase 4 until live RTT and jitter work end to end — Phase 4's
stage handshake extends this exact channel and framing.

## Review Feedback (Codex, 2026-07-29)

### Review State
- **Status: APPROVED**

### Assessment
- All review findings are resolved. Terminal snapshots are preserved, and
  the shared control union includes every Phase 4 extension.
