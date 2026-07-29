# Phase 6 — Live Test Visualization

> **Status**: APPROVED
> **Created**: 2026-07-29
> **Implements**: [main-plan.md](./main-plan.md) — S11 (live test
> visualization) and the `testing` presentation in S8
> **Builds on**: [Phase 2](./02-webrtc-connection.md) — peer profiles and
> locations; [Phase 3](./03-latency-measurement.md) — live RTT/jitter;
> [Phase 4](./04-throughput-measurement.md) — the stage reducer and
> receiver-observed progress; [Phase 5](./05-results-polish.md) — the final
> responsive room shell

## Goal

Replace the functional `testing` presentation with a cinematic but honest
live dashboard: a Three.js dotted Earth, geographic peer markers, the raised
shortest route between them, stage-aware package flow, and Anime.js-powered
speed graph and gauge.

This phase is presentation-only. It consumes the peer profiles and bounded
measurement snapshots already produced by Phases 2–4. It does not add a
message, change a measurement, delay a stage, or write anything to the
result.

## Scope

**In:** the client-only Three.js scene, checked-in world-map asset, geographic
and orientation math, stage-to-visual mapping, particles, real-time SVG
graph and gauge, room-page integration, responsive behavior, accessibility,
resource cleanup, reduced-motion/WebGL fallbacks, performance profiling, and
cross-browser sign-off.

**Out:** changes to signaling, peer-profile fields, geolocation lookup,
control/bulk channel protocols, throughput calculations, result schema,
storage, and results pages.

## Requirements

- Render Earth as a three-dimensional dotted globe with a recognisable land
  map and geographic peer markers.
- Use only the `lat`/`lon` each peer already chose to share. A missing,
  late, malformed, or privacy-reduced location must be handled without
  inventing coordinates or delaying the run.
- When both locations exist, draw the minor great-circle route, lifted above
  the surface, and auto-orient the globe so both endpoints remain visible.
- On desktop, keep the projected north axis at Earth's 23.44-degree axial
  tilt. On mobile, use the available roll degree to put the current peer on
  the left and the remote peer on the right.
- Show package particles along the actual sender-to-receiver direction.
  Relative to this browser, receiving is cyan, sending is violet, and duplex
  is green in both directions. The route color follows the particles.
- Use Three.js for the globe, route, markers, orientation transition, and
  particle animation. Use Anime.js for the real-time SVG line chart and
  dashboard-style speed gauge.
- Keep the receiver-observed semantics from Phase 4. No display may use
  sender-buffered bytes as though they had arrived, and duplex directions
  may not be averaged or summed.
- Preserve the existing numeric metrics, connection badge, stage label,
  Cancel action, error states, finalization, and result transition.
- Remain usable on supported desktop/mobile Chrome, Firefox, and Safari with
  reduced motion, failed/unavailable WebGL 2, resize/orientation changes, and
  background-tab suspension.

## Architecture analysis

### Existing data flow

The room route is planned as the owner of the product state machine:

```
waiting → pairing → paired → testing → finalizing → result
                                 │
                                 ├─ Phase 3: local live RTT/jitter
                                 ├─ Phase 4: active stage and stage bank
                                 └─ Phase 4: progress by (run, stage, receiver)
```

Phase 2's profile bank holds each peer's `id`, slot, name, and optional
`geo.lat`/`geo.lon`. Geo enrichment may arrive after measurement begins;
therefore the globe cannot be an entry barrier and must be able to add or
move markers after mount.

Phase 4 already normalizes live transfer state under the fixed edge identity
`(runId, stageId, receiverSlot)`. A receiver reads its local counters and a
sender reads the peer's validated `measurement-progress`. Both screens thus
have the same receiver-observed speed for an edge, at no more than four
updates per second plus the final update. That reducer output, not either
data channel, is the only source the visualization needs.

### Presentation boundary

Add one pure selector between the room reducer and all animated components:

```
room reducer
  → selectLiveTestPresentation(state, localSlot)
      → globe frame
      → graph samples
      → gauge channels
      → accessible numeric summary
```

The selector emits immutable, display-ready snapshots. Three.js and Anime.js
never receive the transport wrapper, channels, timers, stage controller, or
mutable measurement banks. This boundary makes it mechanically impossible
for a render failure to send protocol traffic or change stored input.

The route updates React state only at the existing bounded progress cadence.
Three.js interpolates visual motion inside its own one
`requestAnimationFrame` loop; no particle position is sent through React
state. Anime.js interpolates the graph/gauge between snapshots and never
creates another measurement sampling loop.

The semantic test surface and optional visualization are separate siblings
at the route boundary:

```
room testing state
  ├─ CoreTestPanel
  │    └─ numeric metrics, status, connection badge, Cancel
  └─ LiveVisualizationBoundary
       └─ Suspense / caught client loader
            └─ LiveTestDashboard (globe, graph, gauge)
```

`CoreTestPanel` is never a descendant of the lazy dashboard, its Suspense
fallback, or its error boundary. A component-local
`LiveVisualizationBoundary` catches a rejected client-only import and
synchronous render/lifecycle exceptions and replaces only the enhancement
with a quiet "enhanced visualization unavailable" panel. It logs locally
for diagnosis but invokes no room action and never resets test state.

React error boundaries do not catch exceptions thrown later by an
imperative RAF, loader callback, or Anime.js callback. Those owners wrap
their async entry points, stop/dispose only their own work, and report
`onVisualError(error)` to the same local fallback. The boundary resets on a
new `runId`; it does not automatically retry a cached rejected module
promise during the same run.

### Stage and color contract

The Phase 4 stage roles remain the source of truth:

| Stage | Network direction | Local slot 0 view | Local slot 1 view |
|---|---|---|---|
| `download` | slot 0 → slot 1 | send, violet | receive, cyan |
| `upload` | slot 1 → slot 0 | receive, cyan | send, violet |
| `duplex` | both directions | two green streams | two green streams |

The stage names stay fixed and are not redefined. "Download" and "upload"
color are explicitly local-view semantics. Consequently, the same
directional transfer is violet on the sender's screen and cyan on the
receiver's, while the physical particle direction is identical on both.

Define semantic CSS/theme tokens in one place:

```
--transfer-receive
--transfer-send
--transfer-duplex
--transfer-idle
```

Choose accessible cyan, violet, green, and neutral values against the final
dark/light surfaces during 6.5. Labels, arrow direction, line style, and
peer names remain present so color is never the only distinction.

### Geographic route

Convert latitude/longitude to one canonical unit-sphere coordinate system,
shared by the land mask, markers, route, and tests. With the camera on +Z,
one suitable convention is:

```
x = cos(lat) * sin(lon)
y = sin(lat)
z = cos(lat) * cos(lon)
```

The route between unit vectors `a` and `b` uses spherical interpolation over
`theta = acos(clamp(dot(a, b), -1, 1))`, so longitude wrapping naturally
chooses the minor arc. Each sample is raised radially by an envelope such as
`1 + h * sin(πt)`: it touches the peer markers at both ends and stays above
the globe elsewhere. `h` is clamped and scaled by angular separation so a
nearby pair does not receive an enormous arch.

Use a Three.js curve plus `TubeGeometry` (or an equivalently thin
camera-stable mesh), not core `LineBasicMaterial` linewidth, whose width is
not portable across WebGL implementations. Route geometry is rebuilt only
when validated coordinates change, never for a speed sample or frame.

Special cases are explicit:

- Longitude near +180/-180 takes the short date-line route.
- Nearly identical coordinates use one shared-location marker treatment and
  a zero-length pulse; they do not get a fabricated inter-city loop.
- Nearly antipodal coordinates use a deterministic north/east fallback
  plane because the exact shortest path is not unique.
- Any non-finite or out-of-schema coordinate is treated as unavailable, not
  clamped into a false location.

### Orientation contract

When both markers exist, point the minor arc's midpoint toward the camera.
This places both endpoints in the visible hemisphere for every
non-antipodal pair. The remaining roll around the camera axis implements the
layout-specific constraint:

- **Desktop (container width at least the shared `md` breakpoint):** roll so
  the projected north axis leans 23.44 degrees from screen vertical. This is
  the visible "real Earth axis" contract; the world, markers, route, and
  subtle polar-axis guide live under the same quaternion.
- **Mobile:** roll so the projected vector from local marker to remote
  marker points left-to-right, then verify `local.x < remote.x`. This
  deliberately replaces the desktop tilt presentation because both roll
  constraints cannot be enforced at once.

Coordinate arrival, viewport breakpoint changes, and mobile orientation
changes compute a new target quaternion. The Three.js render loop uses
shortest-quaternion interpolation to reach it smoothly, then holds it; the
globe must not idle-spin the markers back out of view. A previous stable
quaternion is the fallback when the projected north axis or peer separation
is degenerate.

### Dotted world

Use one `THREE.Points`/`BufferGeometry` cloud generated with an even spherical
distribution. Each point carries equirectangular UV coordinates. A small
same-origin monochrome land mask lets a lightweight shader distinguish
brighter land dots from dimmer ocean dots, yielding a dotted sphere and
recognisable world map in one draw call.

Derive the checked-in mask specifically from Natural Earth's **1:110m
Physical Vectors — Land** dataset, archive identifier `ne_110m_land`,
version 4.0.0. Natural Earth data is public domain; record the exact Land
dataset page, archive filename and checksum, version, retrieval date,
coordinate/projection assumptions, and rasterisation command in
`app/assets/README.md`. There is no production request to Natural Earth or
another map service.

Place a dark sphere just inside the point radius to occlude the far-side
dots and geometry. Keep lighting synthetic and local—no environment map,
external texture, map tile, or location API is needed.

### Particles

Preallocate a small point/instance pool and move it by curve parameter `t`
inside the Three.js loop:

- Directional receive/send uses one stream from the fixed sender marker to
  receiver marker.
- Duplex uses two staggered green streams moving in opposite directions,
  distinguishable by labels and phase/track offset.
- A new stage resets stream direction and eases material color without
  rebuilding the globe.
- Particle velocity and visible count may be monotonically, gently mapped
  from the validated live Mbps to make the display feel alive, but both are
  tightly clamped. They never imply one dot equals one packet.
- `paired`, latency warm-up, stage gaps, and `finalizing` use a neutral or
  stopped route; there is no traffic animation when no transfer is active.

No object, vector, geometry, material, or closure is allocated per frame.
The loop pauses when static, when `document.hidden`, and after unmount.

### Graph and gauge

Both controls are SVG/HTML so they stay crisp, accessible, and available
when WebGL fails.

**Line graph**

- Maintain a bounded, run-scoped ring buffer keyed by edge, populated from
  presentation snapshots only.
- Add an explicit break at stage boundaries so unrelated stages are never
  connected by a misleading diagonal.
- Use a monotonic "nice" 1/2/5 Mbps ceiling that may rise during a run but
  does not fall until the run changes; prior and current stages remain
  visually comparable.
- Render separate stage/edge segments. Receive is cyan, send violet, and
  duplex has two labelled green traces distinguished by solid/dashed
  treatment as well as name.
- Use Anime.js `createAnimatable()` for the frequently changing numeric
  display/point state and `svg.createDrawable()` for first appearance or
  stage-segment draw-in. Reuse and retarget instances on each bounded sample
  rather than spawning an unbounded animation queue.

**Dashboard gauge**

- The dial shows the active receiver-observed Mbps with a numeric value and
  unit. Directional stages use one labelled needle/arc.
- Duplex uses two separately labelled green needles/arcs—local receive and
  local send—on the same scale. Do not sum or average them.
- Share the graph's monotonic scale so the needle does not acquire a new
  meaning between widgets.
- Anime.js eases the numeric value, needle angle, and active arc between
  samples. A new update replaces/retargets the prior interpolation; unmount
  calls `revert()`/`cancel()` as appropriate.

Use Anime.js subpath imports (`animejs/animatable`, `animejs/svg`, or the
smallest verified equivalents) so the room route does not pull unrelated
features into its chunk.

### Key dependencies

| Dependency | Used by | Impact |
|---|---|---|
| `three` | Globe, route, markers, particles | Browser-only async chunk; `WebGLRenderer` requires WebGL 2 and explicit GPU disposal |
| `@types/three` | TypeScript build | Already present at 0.185.1 to match Three.js; verify it remains aligned rather than adding it again |
| `animejs` | SVG graph and gauge | Use v4 APIs and targeted subpath imports; clean up every instance |
| Phase 2 peer profiles | Marker coordinates and labels | May be late or absent; never gates testing |
| Phase 3 metrics | RTT/jitter readout | Numeric/display input only |
| Phase 4 stage/progress reducer | Direction, color, graph, gauge, particle modulation | Must remain receiver-observed and run/stage scoped |
| Natural Earth `ne_110m_land` 4.0.0 | Checked-in land mask | Exact 1:110m Physical Vectors/Land build-time source; no runtime request |
| `ResizeObserver`, `matchMedia`, Page Visibility | Responsive quality and lifecycle | Browser-only guards and test doubles required |

Implementation should verify API details against the installed versions and
their official references:

- [Three.js `WebGLRenderer`](https://threejs.org/docs/pages/WebGLRenderer.html)
  for the WebGL 2 floor, diagnostics, and renderer disposal.
- [Three.js `TubeGeometry`](https://threejs.org/docs/pages/TubeGeometry.html)
  and [point rendering](https://threejs.org/docs/pages/Points.html) for the
  raised route and dotted globe.
- [Anime.js animatables](https://animejs.com/documentation/animatable/) and
  [SVG helpers](https://animejs.com/documentation/svg/) for retargetable live
  values and line draw-in.
- [Natural Earth 1:110m Physical Vectors — Land](https://www.naturalearthdata.com/downloads/110m-physical-vectors/110m-land/)
  and its [public-domain terms](https://www.naturalearthdata.com/about/terms-of-use/)
  for the checked-in mask.

## Work

### 6.1 Presentation model and dependency boundary

**`package.json` / `bun.lock`**

Ensure `three` and `animejs` are classified as runtime dependencies, not
merely development tooling. The project already includes Three.js 0.185.1,
Anime.js 4.5.0, and the matching `@types/three` 0.185.1; do not add the type
package again. Preserve later user version choices rather than blindly
replacing them when implementation starts.

**`app/lib/test-visualization.ts`** (new)

Define `LiveTestPresentation`, transfer modes, graph/gauge channel snapshots,
validated visual locations, and the pure
`selectLiveTestPresentation(roomState, localSlot)` selector.

The selector:

- derives sender/receiver from Phase 4's fixed stage table;
- maps the active direction to local receive/send/duplex semantics;
- consumes the already-normalized local or mirrored receiver snapshot;
- emits no speed when progress is unavailable rather than substituting zero;
- preserves both duplex edge values;
- resets all run-scoped presentation state when `runId` changes; and
- drops stale stage/run snapshots even if a caller accidentally retains one.

**`app/lib/test-visualization.test.ts`** (new)

Table-test both local slots across all three stages, including physical
particle direction, local color, missing progress, two duplex edges, stale
run/stage data, final updates, and run reset. Assert that the selector has no
channel/transport input and never reads sender-buffered byte counters.

*Risk: medium — a wrong slot/view mapping makes a correct test tell the user
that an upload is a download.*

### 6.2 Geographic math and static globe

**`app/lib/globe-math.ts`** + **`app/lib/globe-math.test.ts`** (new)

Implement and unit-test:

- coordinate validation and latitude/longitude → unit vector;
- UV mapping aligned to the same longitude convention;
- stable minor-arc sampling with lifted altitude;
- identical and antipodal fallbacks without `NaN`;
- marker visibility checks in camera space;
- desktop target quaternion with a 23.44-degree projected north-axis tilt;
- mobile target quaternion with local-left/remote-right ordering; and
- shortest-quaternion transition helpers.

Fixtures include equator/prime meridian, poles, Tokyo↔Berlin, +179↔-179
longitude, same-city coordinates, and a nearly antipodal pair. Test the
properties—unit length, endpoints, maximum angular sweep at most π,
above-surface interior, visible endpoints, projected tilt/order—rather than
only snapshotting magic coordinates.

**`app/assets/world-land-mask.png`** +
**`app/assets/README.md`** (new)

Generate a compact equirectangular binary/greyscale land mask from Natural
Earth `ne_110m_land` version 4.0.0, and document the exact Land dataset URL,
archive filename/checksum, retrieval date, source coordinate assumptions,
and reproducible regeneration command. Keep the asset small enough for an
async room-only chunk and verify its seam, longitude direction, and
north/south orientation against known points.

**`app/components/speedtest/PeerGlobe.tsx`** +
**`app/components/speedtest/three/create-globe-scene.ts`** (new)

Create the browser-only scene behind an injected scene factory:

- transparent `WebGLRenderer` with antialiasing chosen by quality tier;
- perspective camera and one root Earth group;
- one dotted point cloud, inner occlusion sphere, subtle atmosphere/axis;
- zero, one, two, or shared-location peer marker treatments;
- DOM overlay labels projected from marker positions, updated via refs
  rather than React state every frame;
- route mesh only when two distinct valid locations exist; and
- a stable textual fallback returned when renderer creation or asset load
  fails.

The React effect owns one renderer and one `ResizeObserver`. Its cleanup
cancels RAF, removes listeners/observers, and disposes every geometry,
material, texture, and renderer. It must remain leak-free under React
StrictMode's mount/unmount/remount cycle.

Use a client-only dynamic import so SSR renders the same stable globe shell
the browser hydrates before Three.js loads. Home and results routes must not
download the Three.js chunk.

*Risk: high — coordinate/map seams, SSR, WebGL context lifetime, and GPU
cleanup fail in different environments and can look fine in one desktop
tab.*

### 6.3 Orientation, route, and package animation

**`app/components/speedtest/three/create-globe-scene.ts`** (extend)

Connect the pure globe frame to the scene:

- animate to the new target quaternion on coordinate/breakpoint changes,
  then hold it;
- rebuild only marker/route geometry affected by coordinate changes;
- update route material from transfer mode without remeshing;
- preallocate directional and duplex particle pools;
- drive curve position and direction from the fixed edge;
- use clamped live Mbps only for decorative velocity/density;
- stop particles during non-transfer states; and
- expose diagnostic counters in development for draw calls, geometries,
  textures, active RAF, and current projected marker coordinates.

Do not add `OrbitControls`: manual rotation could hide a peer and violate
the auto-orientation contract. If exploratory controls are ever useful,
keep them in a development-only harness and never in the product component.

Handle `webglcontextlost` by pausing the scene and revealing the accessible
fallback without touching test state. On `webglcontextrestored`, rebuild
once from the latest immutable presentation snapshot; repeated events must
not create another RAF loop or renderer.

**`app/components/speedtest/PeerGlobe.test.tsx`** (new)

Use the injected scene factory to verify client-only creation, late geo
enrichment, breakpoint changes, transfer-frame updates, missing location,
context loss/restore, visibility pause/resume, StrictMode cleanup, and that a
render error never invokes a room action.

*Risk: high — an attractive continuous loop can consume enough main-thread
or GPU time to perturb a fast local throughput test. The allocation and
quality limits are correctness constraints, not optional polish.*

### 6.4 Anime.js graph and gauge

**`app/lib/speed-series.ts`** +
**`app/lib/speed-series.test.ts`** (new)

Build the pure, bounded ring-buffer and scale model. Test progress
deduplication, stage gaps, run reset, monotonic nice-number scaling, missing
samples, large speeds, and two independent duplex directions.

**`app/components/speedtest/RealtimeSpeedGraph.tsx`** (new)

Render accessible SVG axes, labels, stage bands/segments, and receive/send
series. Retarget persistent Anime.js animatables on new snapshots; use a
drawable only for first/stage appearance. Keep at most the configured
time/sample window in memory and DOM. Do not use path morphing that changes
point topology unpredictably—normalize each series to a fixed display point
count or update an SVG polyline from a fixed numeric buffer.

**`app/components/speedtest/SpeedGauge.tsx`** (new)

Render the radial scale, active arc(s), needle(s), numeric Mbps, direction
label, and unavailable state. Directional mode has one channel; duplex has
two labelled green channels. Retarget rather than queue animations, and
clean them up on mode/run change and unmount.

**Component tests**

With fake time, verify:

- a progress update reaches the correct series and gauge channel;
- a second update retargets instead of adding an orphan animation;
- duplex renders two values and never a total/average;
- missing data reads unavailable rather than `0 Mbps`;
- reduced motion writes the final state synchronously;
- series remain distinguishable without color; and
- unmount cancels/reverts all Anime.js work.

*Risk: medium — uncontrolled tween creation at four updates per second turns
into a memory/performance leak during an otherwise healthy test.*

### 6.5 Dashboard integration, responsive behavior, and accessibility

**`app/components/speedtest/LiveTestDashboard.tsx`** (new) +
**`app/components/speedtest/LiveVisualizationBoundary.tsx`** (new) +
**`app/routes/room.tsx`** (extend) +
**`app/app.css`** (extend)

Mount the dashboard for the measurement portion of `testing`, including the
Phase 3 latency warm-up and all Phase 4 stages. Keep the prior simple metric
panel as the semantic/fallback content rather than deleting it.

In `room.tsx`, render the simple `CoreTestPanel` first and outside the
optional subtree. Wrap only the lazy `LiveTestDashboard` in:

1. a local Suspense/caught-loader pending state;
2. `LiveVisualizationBoundary`, with a fallback that removes no metric,
   status, badge, or control; and
3. an `onVisualError` path used by imperative Three.js/Anime.js work after
   mount.

The boundary records the first visual failure for the current `runId`, stops
and disposes the enhancement, and stays failed for that run. It neither
dispatches a room event nor changes the room reducer. A new run key clears
the local failure state.

Suggested composition:

```
desktop
┌──────────────────────── globe + peer labels ────────────────────────┐
│  connection/stage overlay        raised route + package flow        │
└─────────────────────────────────────────────────────────────────────┘
┌────────────── live graph ──────────────┐ ┌──── speed gauge ─────────┐
│ receive / send / duplex segments       │ │ Mbps + direction         │
└────────────────────────────────────────┘ └──────────────────────────┘

mobile
┌──────── globe: self left / peer right ────────┐
├──────────── compact speed gauge ──────────────┤
├──────────── scroll-safe live graph ───────────┤
└──────── metrics, status, and Cancel ──────────┘
```

Use the globe container's measured width, not user-agent sniffing, for the
desktop/mobile orientation contract. On resize or phone rotation, recompute
camera aspect, renderer size, DOM-label projection, quality tier, and target
quaternion as one coherent update.

Accessibility/lifecycle requirements:

- The canvas is decorative (`aria-hidden`) because equivalent peer,
  location, route direction, stage, and speed text exists in the DOM.
- Stage changes use a polite live region; 250 ms speed updates do not,
  because announcing four values per second would make the UI unusable.
- Cancel remains a normal keyboard-focusable button outside the canvas.
- Receive/send/duplex are named and use arrow/solid/dashed distinctions in
  addition to cyan/violet/green.
- `prefers-reduced-motion: reduce` snaps orientation/gauge/graph changes,
  disables moving particles and draw-in effects, and retains static
  directional arrows plus live numbers.
- When fewer than two valid locations exist, state exactly which peer's
  location is unavailable/hidden. With one marker, face that marker; with
  none, show a static generic globe. Never derive a replacement coordinate
  from an IP or external lookup.
- During `finalizing`, stop particles and freeze the last graph/gauge while
  preserving the status and Cancel/result transition rules from Phase 4.
- A rejected dashboard import, a child render/lifecycle exception, or an
  imperative animation error replaces only the optional visualization.
  Core metrics, status, connection badge, and Cancel remain mounted and
  functional.

Quality tiers cap device pixel ratio and point/particle counts (lower on the
mobile layout). Pause Three.js and Anime.js visual clocks while the document
is hidden; measurement continues, and visibility restoration renders only
the current snapshot rather than replaying missed animation.

*Risk: medium — a canvas-only success would be visually impressive but
unusable to screen-reader, keyboard, reduced-motion, and failed-WebGL
users.*

**`app/components/speedtest/LiveVisualizationBoundary.test.tsx`** (new)

Verify a rejected lazy import and a child that throws during render both
produce only the local unavailable panel. In each case, assert that the core
numeric panel, current stage/status, connection badge, and Cancel remain
present and functional; the room reducer receives no visual-failure action.
Keep the imperative scene/Anime callback failure, renderer-creation, asset,
and context-loss cases in their component suites, all reporting through the
same local fallback contract.

### 6.6 Performance, browser, and visual sign-off

Add a deterministic development fixture/harness that feeds the dashboard
both slots, all stages, fixed progress values, late/missing locations, and
terminal transitions without opening a real room. It is test-only and must
not ship as a public route in production.

Profile both the harness and a real two-peer test:

- Desktop: current Chrome, Firefox, Safari at a representative 1440×900
  viewport.
- Mobile: current iOS Safari and Android Chrome where devices are available,
  with responsive emulation as a repeatable baseline.
- Cases: Tokyo↔Berlin, date-line crossing, same location, near-antipodal,
  one/both locations unavailable, all three transfer modes, reduced motion,
  rejected visualization chunk, thrown visual child, context loss,
  background/resume, viewport rotation, failure/cancel, and late geo
  enrichment.

Budgets:

- One active Three.js RAF and no increasing geometry/texture count across
  repeated stage changes.
- Target 60 fps on desktop and sustained 30 fps or better on the supported
  mobile test device, with no recurring visualization long task above
  50 ms.
- Device pixel ratio capped by quality tier; the mobile canvas must not
  allocate desktop-resolution buffers.
- A small, bounded particle pool and single dotted-globe point draw; steady
  scene draw calls remain within the recorded single-digit budget.
- Three.js/Anime.js/map code loads only with the live dashboard. Record the
  visualization async chunk's gzip size and keep it within an agreed
  250 KiB target or document the measured exception before approval.
- An A/B high-speed local test with the visualization enabled/disabled shows
  no systematic throughput change beyond repeated-run variance. If it does,
  lower quality/animation work before sign-off rather than compensating the
  measurement.

Capture screenshots or short recordings for desktop and mobile orientation
and all transfer colors. Use development projections/logs—not visual
judgement alone—to verify both endpoint camera depths, 23.44-degree desktop
tilt, local-left/remote-right mobile ordering, and particle direction.

Run `bun run test`, `bun run typecheck`, and `bun run build` after the real
browser pass.

*Risk: medium — screenshots can prove appearance but not that the
visualization stayed within its lifecycle and frame budgets; record both.*

## Risks

| Risk | Mitigation |
|---|---|
| A peer withheld location but the UI implies one | Only validated shared `lat`/`lon` create markers; explicit unavailable state, no IP-derived fallback |
| Geo enrichment arrives after testing starts | Presentation selector and scene support late marker/route updates without reopening any barrier |
| Date-line route takes the long way | Unit-vector slerp over `acos(dot)` plus a +179/-179 property test |
| Antipodal or identical coordinates produce `NaN` | Deterministic special cases and property tests before Three.js integration |
| Desktop tilt hides an endpoint | Face the minor-arc midpoint first, then use only camera-axis roll for the 23.44-degree constraint |
| Mobile puts the wrong peer on the left | Orientation takes explicit `localPeerId`; verify projected x-order for both slots |
| Stage name is confused with local download/upload | One table-driven selector maps fixed slots to local receive/send semantics |
| Duplex looks like one combined speed | Two graph traces, two gauge channels, and two opposing particle streams; no total/average field exists |
| Sender bytes masquerade as live throughput | Visualization accepts only Phase 4's normalized receiver snapshot |
| Globe steals resources from measurement | Lazy load, capped DPR/detail, bounded pools, no per-frame allocation, visibility pause, A/B profiling |
| WebGL 2 is unavailable or context is lost | Semantic DOM remains primary; scene failure is isolated and rebuild is idempotent |
| Dashboard chunk or render fails above the renderer | Core panel is a route-level sibling outside a local Suspense/error boundary; only the enhancement falls back |
| React StrictMode creates two render loops | Effect-owned scene factory with explicit dispose and a mount/remount test |
| Anime.js updates accumulate | Persistent retargetable animatables, bounded SVG points, explicit cancel/revert |
| Reduced motion still contains continuous package flow | Particles and draw-in disabled; direction remains through static arrows/text |
| World-map asset adds an external privacy/network dependency | Checked-in same-origin Natural Earth-derived mask with documented provenance |
| Canvas labels are inaccessible or blurred | DOM overlay plus semantic peer/location list; canvas is decorative |

## Done when

**Data and semantics**

- [ ] All six directional local-view cases (two slots × three stages) map to
      the expected physical direction and cyan/violet/green presentation.
- [ ] Globe, graph, gauge, and numeric panel consume the same
      receiver-observed snapshot; no visualization reads sender-buffered
      bytes or creates control/bulk/signaling traffic.
- [ ] Duplex always renders two directions and never a sum or average.
- [ ] Stale `runId`, `stageId`, or `progressSeq` cannot alter any visual,
      graph, or gauge state.

**Globe and route**

- [ ] The dotted land map aligns with known coordinates and has documented,
      reproducible `ne_110m_land` 4.0.0 provenance.
- [ ] With two valid locations, both markers are in the visible hemisphere
      and the route follows the minor great-circle arc above the surface.
- [ ] A +179/-179 pair crosses the date line by the short route.
- [ ] Desktop projects the north axis at 23.44 degrees within a documented
      tolerance while retaining both markers.
- [ ] Mobile places the current peer left and remote peer right for either
      slot, including after orientation change.
- [ ] Same-location and near-antipodal pairs render deterministically without
      `NaN`, flicker, or a fabricated long route.
- [ ] Late geo enrichment creates/reorients markers and route without
      delaying or restarting measurement.
- [ ] Missing, invalid, or Anonymous-profile coordinates create no false
      marker/route and clearly state location is unavailable.
- [ ] Directional particles travel sender → receiver; duplex has two
      opposing green streams; non-transfer states have no traffic flow.

**Graph, gauge, and accessibility**

- [ ] The graph is bounded, stage-separated, and uses a stable monotonic
      scale; the gauge shares that scale.
- [ ] Anime.js instances are retargeted rather than accumulated, and all are
      canceled/reverted on unmount or run reset.
- [ ] Missing speed renders unavailable, not `0 Mbps`; a real zero sample
      remains distinguishable.
- [ ] The semantic DOM exposes peers, available locations, stage, direction,
      RTT, jitter, loss, and speed without requiring the canvas.
- [ ] Cancel and all terminal/error transitions behave exactly as before.
- [ ] A rejected visualization import, thrown visual child, or imperative
      animation failure replaces only the enhancement; numeric metrics,
      status, connection badge, and Cancel remain mounted and functional.
- [ ] Reduced-motion mode has no continuous globe/particle/gauge/graph
      motion and retains clear direction and live numeric values.
- [ ] Receive/send/duplex remain distinguishable with color vision removed.

**Lifecycle and performance**

- [ ] SSR and hydration produce no mismatch, and home/results routes do not
      load the visualization chunk.
- [ ] StrictMode remount, route navigation, stage changes, context
      loss/restore, and background/resume leave exactly one or zero RAFs as
      appropriate, with stable GPU resource counts.
- [ ] Resize/mobile rotation updates canvas size, DPR, labels, camera, and
      orientation without clipping or losing either peer.
- [ ] Desktop/mobile frame, long-task, draw-call, memory, async-chunk, and
      enabled/disabled measurement comparisons are recorded against the 6.6
      budgets.
- [ ] Current Chrome, Firefox, and Safari desktop pass; available iOS Safari
      and Android Chrome devices pass, with emulator evidence filling any
      unavailable hardware cell explicitly rather than silently.
- [ ] `bun run test`, `bun run typecheck`, and `bun run build` pass.

## Acceptance evidence log

| Criterion | Evidence to record |
|---|---|
| Desktop orientation | Projected endpoint depths and north-axis angle plus screenshot |
| Mobile orientation | Projected x-order for both local slots plus portrait/landscape screenshots |
| Minor route | Tokyo↔Berlin, date-line, same-location, and antipodal fixture results |
| Transfer semantics | Recording of both slots for download/upload/duplex with direction/color table |
| Receiver-observed source | Selector test and trace from Phase 4 progress to all widgets |
| Privacy/missing geo | Anonymous, failed lookup, one-location, and late-enrichment captures |
| Reduced motion | OS/browser reduced-motion capture with static arrows and live numbers |
| Visual failure isolation | Rejected chunk, thrown child, imperative error, renderer failure, and context-loss/restore captures with core controls intact |
| Lifecycle | RAF and renderer resource counters across StrictMode, stages, hide/show, and navigation |
| Performance | Browser/device FPS, long-task, draw-call, memory, chunk-size, and A/B notes |
| Accessibility | Keyboard/screen-reader pass and color-independent direction check |
| Build | Final test, typecheck, and production-build output |

## Implementation order

6.1 is first because every widget depends on a single correct stage/local
view. 6.2 follows with pure geographic math before any scene choreography.
After those contracts exist, 6.3 (Three.js motion) and 6.4 (Anime.js
widgets) are independent and can be implemented in either order. 6.5
integrates both into the room state machine. 6.6 is final sign-off, although
its fixture and profiling counters should be added early enough to catch a
bad rendering architecture before polish.

Each step is independently mergeable: pure selectors/math and tests, then a
static fallback-safe globe, then animation, then independent SVG widgets,
then route integration. Do not mark this plan `APPROVED` until the local
receive/send color interpretation, desktop 23.44-degree presentation, and
mobile self-left/peer-right rule have been reviewed; do not mark the overall
product complete until the 6.6 evidence log is filled.

## Review Feedback (Codex, 2026-07-29)

### Review State

- **Status: APPROVED**

### Assessment

- **P1: Resolved.** Visual failures are isolated from the core test UI and
  controls.
- **P2: Resolved.** The land mask uses Natural Earth `ne_110m_land` 4.0.0
  with reproducible provenance.
