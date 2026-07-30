/**
 * Pure geographic and orientation math for the peer globe
 * (06-live-test-visualization 6.2).
 *
 * Deliberately free of any Three.js import: the same numbers drive the land
 * mask's UVs, the markers, the route, the camera orientation, and the unit
 * tests, and a date-line or antipodal bug is far cheaper to find here than
 * inside a render loop. `create-globe-scene.ts` converts these plain values
 * into `THREE.Vector3`/`THREE.Quaternion` at the boundary.
 *
 * Coordinate convention (shared by everything above, camera on +Z):
 *
 *   x = cos(lat) * sin(lon)
 *   y = sin(lat)                 // +y is the north pole
 *   z = cos(lat) * cos(lon)      // lon 0 faces the camera
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface LatLon {
  lat: number;
  lon: number;
}

/** Earth's real axial tilt, the desktop orientation contract's target for the
 * projected north axis (S11). */
export const AXIAL_TILT_DEG = 23.44;

const DEG = Math.PI / 180;

/** Below this angular separation two peers are "in the same place": no arch,
 * no fabricated inter-city loop, just a shared-location pulse. ~0.06°, a few
 * kilometres — well inside the precision an IP lookup offers anyway. */
export const SAME_LOCATION_EPSILON = 1e-3;

/** Within this of π the shortest path is not unique, so a deterministic
 * fallback plane is used instead of a numerically unstable slerp. */
export const ANTIPODAL_EPSILON = 1e-3;

/** Guard for "this projected vector is too short to take an angle from". */
const DEGENERATE_PROJECTION = 1e-6;

export const IDENTITY_QUAT: Quat = { x: 0, y: 0, z: 0, w: 1 };

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function vec(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return vec(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}

export function length(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}

export function scale(a: Vec3, k: number): Vec3 {
  return vec(a.x * k, a.y * k, a.z * k);
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return vec(a.x + b.x, a.y + b.y, a.z + b.z);
}

/** Returns `null` for a zero-length vector rather than a `NaN`-filled one, so
 * every degenerate case has to be handled explicitly by the caller. */
export function normalize(a: Vec3): Vec3 | null {
  const len = length(a);
  if (!Number.isFinite(len) || len < 1e-12) return null;
  return scale(a, 1 / len);
}

/** Latitude/longitude in degrees to a point on the unit sphere. */
export function latLonToVector({ lat, lon }: LatLon): Vec3 {
  const phi = lat * DEG;
  const lambda = lon * DEG;
  const cosPhi = Math.cos(phi);
  return vec(cosPhi * Math.sin(lambda), Math.sin(phi), cosPhi * Math.cos(lambda));
}

/** The exact inverse of `latLonToVector` for a unit vector. */
export function vectorToLatLon(v: Vec3): LatLon {
  return {
    lat: Math.asin(clamp(v.y, -1, 1)) / DEG,
    lon: Math.atan2(v.x, v.z) / DEG,
  };
}

/**
 * Equirectangular UVs for the checked-in land mask, in the same longitude
 * direction as `latLonToVector`. `u = 0` is lon -180 and `v = 0` is the top
 * row of the image (lat +90), which is how the mask is rasterised — see
 * `app/assets/README.md`.
 */
export function vectorToUv(v: Vec3): { u: number; v: number } {
  const { lat, lon } = vectorToLatLon(v);
  return { u: (lon + 180) / 360, v: (90 - lat) / 180 };
}

/** Angular separation in radians, clamped so floating-point drift on a
 * near-parallel pair can never produce `acos` of 1.0000000002. */
export function angleBetween(a: Vec3, b: Vec3): number {
  return Math.acos(clamp(dot(a, b), -1, 1));
}

/**
 * An evenly distributed point cloud on the unit sphere (Fibonacci lattice).
 * Deterministic — the same `count` always yields the same points, so a visual
 * regression is a code change rather than a reroll.
 */
export function fibonacciSphere(count: number): Vec3[] {
  const points: Vec3[] = [];
  if (count <= 0) return points;
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    // y walks the full [-1, 1] range; the offset keeps the first and last
    // points off the exact poles, where UV sampling is ill-conditioned.
    const y = 1 - (2 * (i + 0.5)) / count;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    points.push(vec(Math.cos(theta) * radius, y, Math.sin(theta) * radius));
  }
  return points;
}

export type RouteKind = "arc" | "shared-location" | "antipodal";

export interface RoutePlan {
  kind: RouteKind;
  /** Angular separation in radians, in [0, π]. */
  theta: number;
  /** Peak radial lift above the unit sphere at t = 0.5. Zero for a shared
   * location, so a nearby pair never gets an enormous arch. */
  lift: number;
}

/** Maximum radial lift, reached only for a half-globe separation or more. */
const MAX_LIFT = 0.28;
const MIN_ARC_LIFT = 0.04;

export function planRoute(a: Vec3, b: Vec3): RoutePlan {
  const theta = angleBetween(a, b);
  if (theta < SAME_LOCATION_EPSILON) return { kind: "shared-location", theta, lift: 0 };
  // Lift scales with angular separation so a Tokyo/Yokohama pair gets a
  // barely-raised hop and a Tokyo/Berlin pair gets a visible arch, both
  // clamped well inside the camera frustum.
  const lift = clamp((theta / Math.PI) * MAX_LIFT, MIN_ARC_LIFT, MAX_LIFT);
  if (theta > Math.PI - ANTIPODAL_EPSILON) return { kind: "antipodal", theta, lift };
  return { kind: "arc", theta, lift };
}

/**
 * A deterministic great-circle plane through `a` for the antipodal case,
 * where the shortest path genuinely is not unique. Prefers the plane through
 * the north pole; falls back to the +x ("east") reference when `a` is itself
 * polar and that plane is undefined.
 */
function fallbackPlaneAxis(a: Vec3): Vec3 {
  const north = vec(0, 1, 0);
  const east = vec(1, 0, 0);
  const ref = Math.abs(dot(a, north)) > 0.99 ? east : north;
  const perp = normalize(cross(a, ref));
  // `perp` is non-null by construction: `ref` was chosen not to be parallel
  // to `a`. The null branch exists only so a future edit cannot introduce a
  // silent NaN here.
  if (!perp) return east;
  return normalize(cross(perp, a)) ?? east;
}

/**
 * The unit-sphere direction at parameter `t` along the minor great-circle arc
 * from `a` to `b`. Because the inputs are unit vectors and the sweep is
 * `acos(dot)`, longitude wrapping picks the short way round automatically —
 * a +179/-179 pair crosses the date line rather than travelling 358°.
 */
export function routeDirectionAt(a: Vec3, b: Vec3, t: number, plan: RoutePlan): Vec3 {
  if (plan.kind === "shared-location") return a;
  if (plan.kind === "antipodal") {
    const k = fallbackPlaneAxis(a);
    const angle = Math.PI * t;
    return add(scale(a, Math.cos(angle)), scale(k, Math.sin(angle)));
  }
  const sinTheta = Math.sin(plan.theta);
  const s0 = Math.sin((1 - t) * plan.theta) / sinTheta;
  const s1 = Math.sin(t * plan.theta) / sinTheta;
  return add(scale(a, s0), scale(b, s1));
}

/**
 * The route point at `t`, raised by `1 + lift * sin(pi * t)`. The envelope is
 * exactly 1 at both ends, so the tube touches each marker, and strictly above
 * the surface everywhere between.
 */
export function routePointAt(a: Vec3, b: Vec3, t: number, plan: RoutePlan): Vec3 {
  const direction = routeDirectionAt(a, b, t, plan);
  return scale(direction, 1 + plan.lift * Math.sin(Math.PI * t));
}

/** `segments + 1` points along the route, endpoints included. */
export function sampleRoute(a: Vec3, b: Vec3, segments: number): Vec3[] {
  const plan = planRoute(a, b);
  const count = Math.max(1, Math.floor(segments));
  const points: Vec3[] = [];
  for (let i = 0; i <= count; i++) points.push(routePointAt(a, b, i / count, plan));
  return points;
}

/** The arc's midpoint direction — the point the camera is aimed at so both
 * endpoints land in the visible hemisphere. */
export function routeMidpoint(a: Vec3, b: Vec3): Vec3 {
  return routeDirectionAt(a, b, 0.5, planRoute(a, b));
}

// ---------------------------------------------------------------------------
// Quaternions
// ---------------------------------------------------------------------------

export function quatMultiply(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export function quatNormalize(q: Quat): Quat {
  const len = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
  if (!Number.isFinite(len) || len < 1e-12) return IDENTITY_QUAT;
  return { x: q.x / len, y: q.y / len, z: q.z / len, w: q.w / len };
}

export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const unit = normalize(axis);
  if (!unit) return IDENTITY_QUAT;
  const half = angle / 2;
  const s = Math.sin(half);
  return { x: unit.x * s, y: unit.y * s, z: unit.z * s, w: Math.cos(half) };
}

/** Shortest-arc rotation taking unit vector `from` onto unit vector `to`. */
export function quatFromUnitVectors(from: Vec3, to: Vec3): Quat {
  const d = clamp(dot(from, to), -1, 1);
  if (d > 1 - 1e-9) return IDENTITY_QUAT;
  if (d < -1 + 1e-9) {
    // Opposite vectors: any perpendicular axis is a valid 180° rotation, so
    // pick one deterministically rather than letting `cross` return zero.
    const axis =
      normalize(cross(vec(1, 0, 0), from)) ?? normalize(cross(vec(0, 1, 0), from)) ?? vec(0, 0, 1);
    return quatFromAxisAngle(axis, Math.PI);
  }
  const axis = cross(from, to);
  return quatNormalize({ x: axis.x, y: axis.y, z: axis.z, w: 1 + d });
}

export function quatRotate(q: Quat, v: Vec3): Vec3 {
  // v' = v + 2 * q_vec x (q_vec x v + w * v)
  const qv = vec(q.x, q.y, q.z);
  const t = scale(cross(qv, add(cross(qv, v), scale(v, q.w))), 2);
  return add(v, t);
}

/** Shortest-path spherical interpolation; flips `b`'s sign when the pair is
 * more than a quarter turn apart so the globe never takes the long way. */
export function quatSlerp(a: Quat, b: Quat, t: number): Quat {
  let cosHalf = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  let end = b;
  if (cosHalf < 0) {
    end = { x: -b.x, y: -b.y, z: -b.z, w: -b.w };
    cosHalf = -cosHalf;
  }
  if (cosHalf > 0.9995) {
    return quatNormalize({
      x: a.x + (end.x - a.x) * t,
      y: a.y + (end.y - a.y) * t,
      z: a.z + (end.z - a.z) * t,
      w: a.w + (end.w - a.w) * t,
    });
  }
  const halfTheta = Math.acos(clamp(cosHalf, -1, 1));
  const sinHalfTheta = Math.sin(halfTheta);
  const ratioA = Math.sin((1 - t) * halfTheta) / sinHalfTheta;
  const ratioB = Math.sin(t * halfTheta) / sinHalfTheta;
  return quatNormalize({
    x: a.x * ratioA + end.x * ratioB,
    y: a.y * ratioA + end.y * ratioB,
    z: a.z * ratioA + end.z * ratioB,
    w: a.w * ratioA + end.w * ratioB,
  });
}

// ---------------------------------------------------------------------------
// Orientation contract
// ---------------------------------------------------------------------------

export type GlobeLayout = "desktop" | "mobile";

const CAMERA_FORWARD: Vec3 = { x: 0, y: 0, z: 1 };
const WORLD_NORTH: Vec3 = { x: 0, y: 1, z: 0 };

/**
 * A marker is visible when it is on the camera-facing side of the sphere's
 * horizon. For a perspective camera at distance `d` from a unit sphere's
 * centre, the horizon plane sits at `z = 1 / d` — strictly *inside* the naive
 * `z > 0` hemisphere, which is why a wide pair needs the camera pulled back.
 */
export function isMarkerVisible(v: Vec3, cameraDistance: number): boolean {
  if (!(cameraDistance > 1)) return v.z > 0;
  return v.z > 1 / cameraDistance;
}

export const MIN_CAMERA_DISTANCE = 2.6;
export const MAX_CAMERA_DISTANCE = 9;
/** How far past the horizon plane an endpoint must sit; > 1 so a marker
 * never grazes the silhouette where its label would be unreadable. */
const HORIZON_MARGIN = 1.12;

/**
 * How far back the camera has to sit for both endpoints to clear the horizon.
 *
 * With the arc midpoint facing the camera each endpoint is `theta / 2` away,
 * so its depth is `cos(theta / 2)` and visibility needs
 * `cos(theta / 2) > 1 / d`. Clamped at both ends: a close pair does not get a
 * pointlessly distant camera, and a near-antipodal pair is capped rather than
 * being pushed to infinity — beyond roughly 166 degrees of separation the two
 * markers genuinely cannot share a frame, and the scene says so instead of
 * flying away.
 */
export function recommendedCameraDistance(a: Vec3 | null, b: Vec3 | null): number {
  if (!a || !b) return MIN_CAMERA_DISTANCE;
  const half = angleBetween(a, b) / 2;
  const depth = Math.cos(half);
  if (depth <= 1e-3) return MAX_CAMERA_DISTANCE;
  return clamp(HORIZON_MARGIN / depth, MIN_CAMERA_DISTANCE, MAX_CAMERA_DISTANCE);
}

/** Signed angle of the projected north axis from screen vertical, in degrees.
 * Positive leans right (north pole toward +x on screen). `null` when north
 * points at or away from the camera and the projection has no meaningful
 * direction. */
export function projectedNorthTiltDeg(q: Quat): number | null {
  const north = quatRotate(q, WORLD_NORTH);
  if (Math.hypot(north.x, north.y) < DEGENERATE_PROJECTION) return null;
  return Math.atan2(north.x, north.y) / DEG;
}

export interface OrientationInput {
  layout: GlobeLayout;
  /** This browser's own marker. */
  local: Vec3 | null;
  remote: Vec3 | null;
  /** Held when the new target would be degenerate. */
  previous?: Quat;
}

export interface OrientationResult {
  quat: Quat;
  /** Why this orientation was chosen — surfaced in the dev diagnostics so a
   * "wrong-looking" globe can be explained without guessing. */
  reason:
    | "both-markers"
    | "single-marker"
    | "no-markers"
    | "degenerate-hold";
}

/**
 * The target orientation for the Earth group.
 *
 * Step 1 always aims the arc midpoint (or the single marker) at the camera,
 * which puts every non-antipodal pair in the visible hemisphere. Step 2 uses
 * the one remaining degree of freedom — roll about the camera axis — for the
 * layout-specific constraint. The two constraints cannot both hold, which is
 * exactly why mobile trades the tilt away for self-left/peer-right.
 */
export function targetOrientation(input: OrientationInput): OrientationResult {
  const { layout, local, remote, previous } = input;

  if (!local && !remote) {
    // Nothing to face: a static, honestly generic globe at Earth's tilt.
    return { quat: applyTilt(IDENTITY_QUAT, undefined).quat, reason: "no-markers" };
  }

  if (!local || !remote) {
    const only = (local ?? remote)!;
    const face = quatFromUnitVectors(only, CAMERA_FORWARD);
    const tilted = applyTilt(face, previous);
    return { quat: tilted.quat, reason: tilted.held ? "degenerate-hold" : "single-marker" };
  }

  const midpoint = normalize(routeMidpoint(local, remote));
  if (!midpoint) return { quat: previous ?? IDENTITY_QUAT, reason: "degenerate-hold" };
  const face = quatFromUnitVectors(midpoint, CAMERA_FORWARD);

  if (layout === "desktop") {
    const tilted = applyTilt(face, previous);
    return { quat: tilted.quat, reason: tilted.held ? "degenerate-hold" : "both-markers" };
  }

  // Mobile: roll until the projected local -> remote vector points right.
  const lp = quatRotate(face, local);
  const rp = quatRotate(face, remote);
  const dx = rp.x - lp.x;
  const dy = rp.y - lp.y;
  if (Math.hypot(dx, dy) < DEGENERATE_PROJECTION) {
    // The two markers project onto (nearly) the same screen point — a shared
    // location. There is no left/right to establish, so hold the previous
    // stable orientation, or just face the pair if there isn't one.
    return {
      quat: previous ?? face,
      reason: previous ? "degenerate-hold" : "both-markers",
    };
  }
  return { quat: rollAboutCamera(face, -Math.atan2(dy, dx)), reason: "both-markers" };
}

/**
 * Rotate about the camera axis (+Z in view space) *after* `q`.
 *
 * A positive `angle` turns the world counter-clockwise on screen, which
 * decreases `projectedNorthTiltDeg` by the same amount — hence the sign in
 * `applyTilt` below.
 */
function rollAboutCamera(q: Quat, angle: number): Quat {
  return quatNormalize(quatMultiply(quatFromAxisAngle(CAMERA_FORWARD, angle), q));
}

/** Roll `face` so the projected north axis sits at Earth's axial tilt. When
 * north points at or away from the camera there is no projected direction and
 * so no tilt to enforce: keep the last stable orientation rather than snapping
 * to an arbitrary roll. */
function applyTilt(face: Quat, previous: Quat | undefined): { quat: Quat; held: boolean } {
  const current = projectedNorthTiltDeg(face);
  if (current === null) return { quat: previous ?? face, held: previous !== undefined };
  return { quat: rollAboutCamera(face, (current - AXIAL_TILT_DEG) * DEG), held: false };
}
