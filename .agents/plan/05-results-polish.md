# Phase 5 — Results Page, Polish, and Core Sign-off

> **Status**: APPROVED
> **Created**: 2026-07-29
> **Implements**: [main-plan.md](./main-plan.md) — S7 (persistence, import,
> export), S8 (results page), plus core-flow sign-off
> **Builds on**: [Phase 4](./04-throughput-measurement.md) — the records it
> writes, the shared hash, and the validation foundation
> **Conforms to**: `schemas/p2p-speedtest-result.v1.schema.yaml`

## Goal

Build `/results` — list, detail, import, export, sharing — then close the
remaining core-flow robustness gaps with evidence. Phase 6 owns the
live-test globe, graph, gauge, animation fallbacks, and their final visual
performance sign-off.

## Design notes

### This page is a pure consumer

It reads what Phase 4 wrote and displays it, without reinterpreting,
relabelling, or re-aggregating: no "download"/"upload" framing over
`data.bandwidth.directional[]` (the schema models a peer-to-peer graph, S6),
no recomputing `via` or latency. The only transformation permitted is bits
per second → Mbps.

**The two bandwidth groups stay separate.** `directional` measures each way
in isolation; `duplex` measures both competing (S5). They answer different
questions and are expected to differ — never average them, never merge them,
never present one as a correction of the other. The gap between them is
information, not noise to smooth away.

Either group may be absent or hold a single edge on a non-`SUCCEED` record:
a run that died during the duplex stage keeps its directional pair because
Phase 4 required both directional `stage-result` acknowledgements before
duplex could start, and may have no duplex group at all. Render what is
present rather than assuming four edges.

Before building UI on it, spot-check a real IndexedDB row against the schema
file.

### Records may legitimately disagree

Two peers who completed a test hold byte-identical records (S6). Two peers
whose exchange was interrupted hold *different* records — each an honest
account of what it measured.

The results page must never treat that as corruption. It shows one browser's
history; it has no access to the other's, no way to compare, and no reason
to. A record that is partial says so through its `status` and its missing
groups.

### SSR safety

These routes can render server-side, where browser IndexedDB does not exist.
All storage access must be client-only — open the database in an effect or a
client-guarded path — with a stable empty/loading state during SSR so
hydration does not mismatch. Build this as its own step before any UI sits
on it.

### Non-`SUCCEED` records are normal

`FAILED` and `CANCELED` records exist and may have fewer edges, incomplete
bandwidth groups, and `via: UNKNOWN`. They still contain both peer entries;
profile fields may be absent and the fallback name may be all that is known.
List and detail render the available data without hiding or crashing.
`UNKNOWN` gets its own visually distinct badge state and is never silently
degraded to `DIRECT`.

### Copied links are local-only

A `/results/:room/:peerId` link resolves only in a browser that already
holds that record. Say so inline next to the copy-link action rather than
letting users assume it works cross-device — export/import is the actual
portability path (S7).

## Work

### 5.1 Routes and SSR-safe reads

**`app/routes.ts`** — add `route("results", "routes/results.tsx")` and
`route("results/:room/:peerId", "routes/results.$room.$peerId.tsx")`. Both
segments are URL-path-safe as-is: `room` is the 9-character slug, `peerId` a
hyphenated UUID.

**`app/lib/results.ts`** (extend) — async `listResults()` and
`getResult(room, peerId)`. The storage adapter never opens IndexedDB on the
server; routes render a stable loading/empty shell and resolve these calls
client-side. `getResult` reads the out-of-line compound key
`[room, peerId]`; `listResults` iterates the object store and validates each
envelope without relying on a separate, race-prone index array.

*Risk: medium — hydration mismatches fail silently. Verify the initial SSR
HTML matches the client render.*

### 5.2 List and detail views

**`app/routes/results.tsx`** (new) — stored results newest-first as
rows/cards: `data.timestamp`, a bandwidth summary (bps → Mbps), the `via`
badge (Phase 2's component, extended with `UNKNOWN`), and a `data.status`
indicator. Plus an empty state.

Identify peers by `name`: it is what the two people agreed to call
themselves, and a raw UUID tells a reader nothing.

For the row summary, lead with the `directional` pair — the figure people
compare against other speedtests — and show `duplex` as a clearly secondary,
separately-labelled reading. A row for a record with no duplex group must
not look broken; it simply has no second reading.

**`app/routes/results.$room.$peerId.tsx`** (new) — the full record via
`getResult`: `metadata` (id, peer-id, hash) and all of `data`.

Per peer: `name` and `ip` (which may be masked, e.g. `104.xxx.xxx.235`),
plus `ua` and `geo` where present. Absent fields mean that peer chose a
privacy level withholding them (S3) — render those rows not at all, rather
than as "unknown" or a blank. Show a masked IP verbatim without annotating
it as masked, since its shape already says so. A `geo` holding only
`proxy`/`hosting` is normal rather than partial data: render the flags and
omit the location block, since a proxied or hosted endpoint is real context
for an unusual number.

Per group: `directional` and `duplex` as two labelled sets, each with its
two edges and their own latency, jitter, and loss. The difference between
the groups' latencies is where bufferbloat shows, so do not collapse them
into one figure. Show `loss` as a percentage.

A record missing from this browser's storage gets a clear not-found message,
not a crash.

### 5.3 Export

**`app/lib/results.ts`** (extend)

Async `exportResults(keys?)` producing `{ results: [...] }` — each entry a
full envelope read from IndexedDB, no separate top-level version wrapper,
since every record carries its own `apiVersion` — and triggering a JSON
download. All results by default; a selection if the list view adds
selection UI.

### 5.4 Import

**`app/lib/results.ts`** (extend)

`importResults(file)` parses the outer `{ results }` shape first; that is
the only fatal case. Then, **per entry**, in order:

1. Missing or malformed `apiVersion`/`kind` → skip as malformed, with a
   visible warning.
2. Any `apiVersion` other than `sws.aries0d0f.me/v1` → skip as unsupported,
   naming the version found ("entry uses sws.aries0d0f.me/v2, not supported
   by this version"). Never coerced into a current-shape record.
3. **`validateEnvelope(entry)`** (5.4b) — schema, data semantics, metadata
   identity, then checksum. Each failure carries its own message, so a user
   can tell a malformed file from a corrupted record: a checksum failure
   reads *"checksum mismatch — this entry is corrupted"*, an identity
   failure names the field that disagrees.

Entries that pass merge by `metadata.peer-id` + `data.room` through
async `saveResult`'s transactional first-write-wins rule (Phase 4), not a
second merge implementation here.

**Say what the checksum proves, and no more.** It detects corruption, not
forgery (S6): a hand-authored record can carry a perfectly valid digest. The
warning text must not imply an entry "was not produced by this app", because
a matching checksum does not establish that it was. Import is a data-quality
gate over the importer's own history, not a trust boundary.

*Risk: medium — validation must be genuinely per-entry, so one bad record
never aborts a file. Write deliberately broken fixtures for every step,
including one that passes schema validation but fails semantics, and one
that passes both but has tampered `data`.*

### 5.4b Envelope validation

**`app/lib/result-validate.ts`** (extend — created in Phase 4)

Phase 4 owns the foundation, because each peer validates assembled `data`
before hashing it: `validateData`, the Ajv + `ajv-formats` setup, and the
build-time YAML→JSON conversion. This phase re-creates none of it.

What import needs beyond `validateData` is everything that exists only once
a record has a `metadata` block:

**`validateEnvelope(entry)`** = `validateData(entry.data)` plus

- `apiVersion` and `kind` match this app's,
- `metadata.id === data.room`,
- `metadata.peer-id` occurs **exactly once** in `data.peers[].id`,
- the checksum matches `computeResultHash(entry.data)`.

The metadata identity checks matter because the checksum covers `data` only:
an importer can rewrite `metadata.id` or `metadata.peer-id` freely without
breaking it, leaving a record stored under an identity its own contents
contradict. An assembling peer cannot perform these checks, since at that
point it is building its own `metadata` rather than verifying one.

Return structured failures — which check, which entry — so the import UI can
say what was wrong rather than "invalid".

### 5.5 Sharing

Both pages get **both actions**, copy-text and copy-link.

**`app/routes/room.tsx`** — on the `result` state: copy-text, plus a
copy-link built from the record's `data.room` and this browser's
`metadata.peer-id`, carrying the local-only caveat.

**`app/routes/results.$room.$peerId.tsx`** — the same pair.

**Copy text must be honest about partial records.** It always includes
`data.via` and names each bandwidth group. An absent group is written out as
unavailable — `Duplex: not measured` — rather than omitted or shown as zero.
A `FAILED` record whose copied text silently lacks a section reads as a
complete result with suspiciously few numbers.

### 5.6 Robustness

**Error sub-states** (`app/routes/room.tsx`, `app/lib/webrtc.ts`) — handled
as sub-states of `pairing`/`testing`/`finalizing`, never new routes.

The table below implements S6's matrix, adding the UI state and the test.
S6 is normative; where they appear to differ, S6 wins. Every row is a test
case with a stated persistence outcome — "add a try/catch" is not
sufficient.

| Scenario | Expected state | Record written? |
|---|---|---|
| Peer closes during `waiting` | stays `waiting` | no |
| Peer closes during `pairing` | terminal failure, offer a new room | no |
| ICE fails during `pairing` (incl. hard NAT, STUN-only) | terminal failure, offer a new room | no |
| Peer closes during a directional stage | `FAILED` result | yes — survivor only |
| Peer closes during the duplex stage | `FAILED`, acknowledged directional pair retained | yes — survivor only |
| Peer closes during `finalizing`, before its share | `FAILED`, acknowledged bank plus any local sealed edge | yes — survivor only |
| User cancels during `testing` | `CANCELED` result | yes, partial, both peers |
| Share lost in one direction only | both assemble | yes, both — checksums differ |
| Duplicate `result-share` | ignored | one entry only |
| Signaling socket drops after `paired`, before measurement | terminal failure, offer a new room | no |
| Signaling socket drops during `testing`/`finalizing` | `FAILED` partial result | yes — each surviving peer |
| Hard expiry during `waiting`/`pairing` | "this room expired" | no |
| Hard expiry during `testing`/`finalizing` | expired notice plus partial result | yes |
| Malformed IndexedDB row | warning, malformed row left untouched; valid rows still render | no replacement write |
| IndexedDB open/transaction failure | visible storage error; database is not deleted or recreated | no |
| IndexedDB quota exceeded | visible "couldn't save" | no |

Note the "survivor only" rows: a peer that closed its tab stores nothing, so
those tests must check **both** browsers — one holds a record, the other
none. Checking only the survivor would pass while a bug wrote records in
neither.

Use Phase 1's kill-the-network-without-a-clean-close pattern as the template
for the close cases, and link each row to the evidence log.

**QR and copy UI** — polish Phase 1's functional-but-minimal version: visual
design, clearer copy confirmation.

**Responsive layout** (`app/app.css`, all routes) — verify and adjust across
home, room, and results at mobile, tablet, and desktop widths. Mobile
browsers are supported, so these are real targets rather than best-effort.

## Risks

| Risk | Mitigation |
|---|---|
| SSR/hydration mismatch on `/results` | 5.1 is its own step with a hydration check, before any UI |
| Import rejecting a whole valid export over one bad record | Deliberately broken fixtures, not happy-path testing |
| A partial record read as corruption rather than an honest account | The page shows one browser's history and never compares across peers |
| Edge-case error handling under-scoped, leaving the room page stuck | Every row of the 5.6 matrix is an individual test case before the phase is done |
| Results disappear when two tabs save concurrently | Reads enumerate independently keyed IndexedDB rows; Phase 4's two-tab transaction test is repeated through the list page |

## Done when

**The pages**

- [ ] `/results` renders with real data and with empty storage, no SSR or
      hydration errors.
- [ ] Two same-origin tabs saving the two peer identities simultaneously
      leave two rows visible on `/results`; refreshing and SSR hydration do
      not lose either.
- [ ] `/results/:room/:peerId` renders a full record; not-found is handled
      gracefully.
- [ ] Every field renders as the schema defines it — no relabelling of
      bandwidth edges as download/upload, with `directional` and `duplex` as
      separate labelled groups rather than merged or averaged.
- [ ] A record with a directional pair but no duplex group renders correctly
      in both views, without looking broken or implying a missing
      measurement is a zero.
- [ ] `FAILED`/`CANCELED` entries, including `via: UNKNOWN` and partial
      data, render correctly in both views, with `UNKNOWN` as its own badge
      state.
- [ ] A peer that withheld `ua` or `geo` renders without those rows, and a
      `geo` holding only `proxy`/`hosting` reads as normal rather than
      broken.

**Import and export**

- [ ] Export produces a schema-valid `{ results: [...] }` file that
      re-imports into empty storage with no loss and no duplication.
- [ ] Importing a file with bad entries skips only those, with warnings —
      one fixture per validation step, each producing its own message.
- [ ] A record whose `metadata.id` or `metadata.peer-id` was edited while
      `data` is untouched is **rejected by the semantic validator**, even
      though its checksum still matches.
- [ ] `validateEnvelope` builds on Phase 4's `validateData` rather than
      duplicating it — one broken `data` fixture gives the same verdict
      through an assembling peer's path and the import path.
- [ ] Import warning text describes corruption only, and nowhere claims a
      matching checksum proves origin.

**Sharing and robustness**

- [ ] Copy-text and copy-link work from both the room and results pages,
      always including `data.via`, with absent groups explicitly marked
      unavailable rather than omitted.
- [ ] A signaling socket drop follows the one-run boundary: before
      measurement it produces no record; during `testing`/`finalizing` each
      surviving peer stores an honest `FAILED` partial record.
- [ ] A run where only one direction's share arrives leaves both browsers
      with valid, individually honest records — checked in both.
- [ ] Every row of the 5.6 matrix has been exercised, with its stated
      persistence outcome confirmed.
- [ ] Responsive layout verified at mobile, tablet, and desktop widths on
      all three pages.
- [ ] Full cross-browser pass (Chrome, Firefox, Safari), including a
      forced-relay run per browser.
- [ ] Every main-plan criterion owned by Phases 1–5 is checked off, with the
      evidence log below filled in.
- [ ] `bun run typecheck` and `bun run build` pass.

## Acceptance evidence log

A checked box is too easy to satisfy informally. Fill this in as work is
verified — not all at the end, so a late cross-browser or TURN problem
surfaces before sign-off.

| Main-plan criterion | Evidence to record |
|---|---|
| Room joinable by link/QR, Room ID, emoji key | Which browsers/devices tested each method |
| Connects direct and relayed | Forced-relay log per browser |
| Badge accuracy | Note or screenshot confirming the badge matched the actual `getStats()` classification, both conditions |
| Latency measured live | Reference Phase 3 sign-off |
| Bandwidth measured, summary shown | Reference Phase 4 sign-off plus this phase's schema spot-check |
| Records identical across peers | Both browsers' stored entries for one test, diffed on `data` and `hash` |
| **DO retains no application peer data** | Storage/attachment dump after a run, plus a signaling-socket capture showing no profile, measurement, or result messages; SDP/ICE candidate addresses are expected protocol traffic |
| Privacy levels honoured | Data-channel capture per level, showing exactly the fields S3's table allows |
| Import rejects semantically broken records | The edited-metadata fixture's rejection, showing which invariant failed |
| Robustness matrix | The 5.6 table with each row's observed state and whether a record was written |
| Failed/canceled tests persist and display | One deliberately failed test's record, list and detail rendering |
| Stale slot replaceable, live peer never evicted | Notes from re-running Phase 1's kill-network test against the final build |
| Idle room cleanup | Dashboard/log evidence of an alarm firing |
| Routes exist and stay in scope | The routes as implemented |
| Results persist per schema | A real exported file, redacted if needed |
| Export/import round-trips | Before/after entry counts for a real round trip |
| DO bound and migrated, dispatch correct | `wrangler.jsonc` diff plus confirmation `/room/:slug` still SSRs |
| `typecheck` / `build` pass | Final command output |
| Cross-browser + forced-relay | The 3 browsers × direct/relayed matrix, all six cells checked |

## Order

5.1 comes first — 5.2, 5.3, and 5.4 all depend on it. 5.5's room-page half
can start as soon as Phase 4 is done; its results-page half needs 5.2. 5.6
is the least coupled and can be picked up incrementally rather than strictly
last.

Do not start Phase 6 until every 5.6 room-state matrix case has its stated
persistence outcome and the responsive room page has stable
`testing → finalizing → result` transitions, live numeric metrics, and a
working Cancel action — Phase 6 adds an optional visualization around that
exact fallback surface.

## Review Feedback (Codex, 2026-07-29)

### Review State
- **Status: APPROVED**

### Assessment
- All review findings are resolved. Results consumption, IndexedDB
  portability, the robustness matrix, and final evidence requirements align
  with Phase 4.
