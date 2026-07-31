import { describe, expect, it } from "vitest";

import {
  ANTIPODAL_EPSILON,
  AXIAL_TILT_DEG,
  MAX_CAMERA_DISTANCE,
  MIN_CAMERA_DISTANCE,
  angleBetween,
  cross,
  dot,
  fibonacciSphere,
  isMarkerVisible,
  geoPointToVector,
  length,
  normalize,
  planRoute,
  recommendedCameraDistance,
  projectedNorthTiltDeg,
  quatFromUnitVectors,
  quatRotate,
  quatSlerp,
  routeMidpoint,
  sampleRoute,
  targetOrientation,
  vec,
  vectorToGeoPoint,
  vectorToUv,
} from "~/lib/globe-math";
import type { GeoPoint } from "~/model/geo.model";
import type { Quat, Vec3 } from "~/model/globe.model";

const TOKYO: GeoPoint = { lat: 35.6762, lon: 139.6503 };
const BERLIN: GeoPoint = { lat: 52.52, lon: 13.405 };
const SYDNEY: GeoPoint = { lat: -33.8688, lon: 151.2093 };
const NULL_ISLAND: GeoPoint = { lat: 0, lon: 0 };
const NORTH_POLE: GeoPoint = { lat: 90, lon: 0 };
const SOUTH_POLE: GeoPoint = { lat: -90, lon: 0 };
const DATELINE_WEST: GeoPoint = { lat: 10, lon: 179 };
const DATELINE_EAST: GeoPoint = { lat: 10, lon: -179 };
/** Tokyo's exact antipode. */
const TOKYO_ANTIPODE: GeoPoint = { lat: -35.6762, lon: -40.3497 };
/** Half a degree off the antipode: outside the fallback-plane band, but the
 * widest separation an ordinary arc has to survive. */
const TOKYO_NEAR_ANTIPODE: GeoPoint = { lat: -35.6762, lon: -39.85 };

const CAMERA_DISTANCE = 3;

function isFiniteVec(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

describe("coordinate conversion", () => {
  it("produces unit vectors", () => {
    for (const p of [TOKYO, BERLIN, SYDNEY, NULL_ISLAND, NORTH_POLE, SOUTH_POLE]) {
      expect(length(geoPointToVector(p))).toBeCloseTo(1, 12);
    }
  });

  it("places the prime meridian at the equator facing the camera", () => {
    const v = geoPointToVector(NULL_ISLAND);
    expect(v.x).toBeCloseTo(0, 12);
    expect(v.y).toBeCloseTo(0, 12);
    expect(v.z).toBeCloseTo(1, 12);
  });

  it("puts the north pole on +y and the south pole on -y", () => {
    expect(geoPointToVector(NORTH_POLE).y).toBeCloseTo(1, 12);
    expect(geoPointToVector(SOUTH_POLE).y).toBeCloseTo(-1, 12);
  });

  it("increases x with easterly longitude", () => {
    expect(geoPointToVector({ lat: 0, lon: 90 }).x).toBeCloseTo(1, 12);
    expect(geoPointToVector({ lat: 0, lon: -90 }).x).toBeCloseTo(-1, 12);
  });

  it("round-trips through vectorToGeoPoint", () => {
    for (const p of [TOKYO, BERLIN, SYDNEY, DATELINE_WEST, DATELINE_EAST]) {
      const back = vectorToGeoPoint(geoPointToVector(p));
      expect(back.lat).toBeCloseTo(p.lat, 9);
      expect(back.lon).toBeCloseTo(p.lon, 9);
    }
  });
});

describe("UV mapping", () => {
  it("agrees with the mask's corners and centre", () => {
    expect(vectorToUv(geoPointToVector(NULL_ISLAND))).toEqual({ u: 0.5, v: 0.5 });
    expect(vectorToUv(geoPointToVector(NORTH_POLE)).v).toBeCloseTo(0, 12);
    expect(vectorToUv(geoPointToVector(SOUTH_POLE)).v).toBeCloseTo(1, 12);
    expect(vectorToUv(geoPointToVector({ lat: 0, lon: -180 })).u).toBeCloseTo(0, 12);
    expect(vectorToUv(geoPointToVector({ lat: 0, lon: 179.999 })).u).toBeCloseTo(1, 5);
  });

  it("uses the same longitude direction as geoPointToVector", () => {
    const west = vectorToUv(geoPointToVector({ lat: 0, lon: -90 }));
    const east = vectorToUv(geoPointToVector({ lat: 0, lon: 90 }));
    expect(west.u).toBeLessThan(east.u);
  });

  it("keeps every UV inside the texture for a dense point cloud", () => {
    for (const p of fibonacciSphere(2000)) {
      const uv = vectorToUv(p);
      expect(uv.u).toBeGreaterThanOrEqual(0);
      expect(uv.u).toBeLessThanOrEqual(1);
      expect(uv.v).toBeGreaterThanOrEqual(0);
      expect(uv.v).toBeLessThanOrEqual(1);
    }
  });
});

describe("fibonacciSphere", () => {
  it("returns unit-length, evenly spread, deterministic points", () => {
    const points = fibonacciSphere(500);
    expect(points).toHaveLength(500);
    for (const p of points) expect(length(p)).toBeCloseTo(1, 9);
    // Even distribution: the centroid of a uniform sphere sample is ~origin.
    const centroid = points.reduce((acc, p) => vec(acc.x + p.x, acc.y + p.y, acc.z + p.z), vec(0, 0, 0));
    expect(length(centroid) / points.length).toBeLessThan(0.02);
    expect(fibonacciSphere(500)).toEqual(points);
  });

  it("handles a zero count", () => {
    expect(fibonacciSphere(0)).toEqual([]);
  });
});

describe("route planning", () => {
  it("classifies the three cases", () => {
    expect(planRoute(geoPointToVector(TOKYO), geoPointToVector(BERLIN)).kind).toBe("arc");
    expect(planRoute(geoPointToVector(TOKYO), geoPointToVector(TOKYO)).kind).toBe("shared-location");
    // Half a degree short of the antipode is still an ordinary arc: the
    // fallback plane must not quietly swallow real long-haul routes.
    expect(planRoute(geoPointToVector(TOKYO), geoPointToVector(TOKYO_NEAR_ANTIPODE)).kind).toBe("arc");
    const a = geoPointToVector(TOKYO);
    expect(planRoute(a, vec(-a.x, -a.y, -a.z)).kind).toBe("antipodal");
    expect(planRoute(a, geoPointToVector(TOKYO_ANTIPODE)).kind).toBe("antipodal");
  });

  it("gives a shared location no arch at all", () => {
    const plan = planRoute(geoPointToVector(TOKYO), geoPointToVector(TOKYO));
    expect(plan.lift).toBe(0);
    expect(plan.theta).toBeLessThan(1e-6);
  });

  it("scales lift with separation but clamps both ends", () => {
    const near = planRoute(geoPointToVector(TOKYO), geoPointToVector({ lat: 35.5, lon: 139.6 }));
    const far = planRoute(geoPointToVector(TOKYO), geoPointToVector(BERLIN));
    expect(near.lift).toBeGreaterThan(0);
    expect(near.lift).toBeLessThan(far.lift);
    expect(far.lift).toBeLessThanOrEqual(0.28);
  });
});

describe("great-circle route sampling", () => {
  const pairs: Array<[string, GeoPoint, GeoPoint]> = [
    ["Tokyo/Berlin", TOKYO, BERLIN],
    ["Berlin/Tokyo", BERLIN, TOKYO],
    ["date line", DATELINE_WEST, DATELINE_EAST],
    ["equator/prime meridian", NULL_ISLAND, { lat: 0, lon: 45 }],
    ["pole to pole", NORTH_POLE, SOUTH_POLE],
    ["same city", TOKYO, TOKYO],
    ["near antipodal", TOKYO, TOKYO_NEAR_ANTIPODE],
    ["Sydney/Berlin", SYDNEY, BERLIN],
  ];

  for (const [name, from, to] of pairs) {
    it(`${name}: endpoints, no NaN, above the surface`, () => {
      const a = geoPointToVector(from);
      const b = geoPointToVector(to);
      const points = sampleRoute(a, b, 48);

      expect(points).toHaveLength(49);
      for (const p of points) expect(isFiniteVec(p)).toBe(true);

      // Touches both markers exactly.
      expect(length(vec(points[0].x - a.x, points[0].y - a.y, points[0].z - a.z))).toBeLessThan(1e-9);
      const last = points[points.length - 1];
      expect(length(vec(last.x - b.x, last.y - b.y, last.z - b.z))).toBeLessThan(1e-9);

      // Interior stays above the sphere (or exactly on it for same-city).
      const sameCity = angleBetween(a, b) < 1e-3;
      for (let i = 1; i < points.length - 1; i++) {
        const r = length(points[i]);
        expect(r).toBeGreaterThanOrEqual(sameCity ? 1 - 1e-9 : 1 + 1e-6);
        expect(r).toBeLessThan(1.3);
      }
    });

    it(`${name}: total sweep never exceeds pi`, () => {
      const a = geoPointToVector(from);
      const b = geoPointToVector(to);
      const points = sampleRoute(a, b, 64).map((p) => normalize(p)!);
      let sweep = 0;
      for (let i = 1; i < points.length; i++) sweep += angleBetween(points[i - 1], points[i]);
      expect(sweep).toBeLessThanOrEqual(Math.PI + 1e-6);
    });
  }

  it("crosses the date line by the short route", () => {
    const points = sampleRoute(
      geoPointToVector(DATELINE_WEST),
      geoPointToVector(DATELINE_EAST),
      32,
    ).map((p) => vectorToGeoPoint(normalize(p)!));
    // 2 degrees apart, not 358: every sample stays in the |lon| >= 179 band.
    for (const p of points) expect(Math.abs(p.lon)).toBeGreaterThanOrEqual(178.9);
  });

  it("is symmetric: reversing the endpoints reverses the samples", () => {
    const a = geoPointToVector(TOKYO);
    const b = geoPointToVector(BERLIN);
    const forward = sampleRoute(a, b, 16);
    const backward = sampleRoute(b, a, 16).reverse();
    for (let i = 0; i < forward.length; i++) {
      expect(forward[i].x).toBeCloseTo(backward[i].x, 9);
      expect(forward[i].y).toBeCloseTo(backward[i].y, 9);
      expect(forward[i].z).toBeCloseTo(backward[i].z, 9);
    }
  });

  it("uses a deterministic plane for an exactly antipodal pair", () => {
    const a = geoPointToVector(TOKYO);
    const b = vec(-a.x, -a.y, -a.z);
    const first = sampleRoute(a, b, 24);
    const second = sampleRoute(a, b, 24);
    expect(first).toEqual(second);
    for (const p of first) expect(isFiniteVec(p)).toBe(true);
    // The plane is the one through the north pole, so the path leaves the
    // start heading polewards rather than in some arbitrary direction.
    const mid = normalize(routeMidpoint(a, b))!;
    expect(Math.abs(dot(mid, a))).toBeLessThan(1e-6);
  });

  it("uses the east fallback plane when the endpoint is itself polar", () => {
    const a = geoPointToVector(NORTH_POLE);
    const b = geoPointToVector(SOUTH_POLE);
    // Pole to pole is exactly antipodal *and* parallel to the north
    // reference, so the fallback has to switch axes rather than divide by 0.
    for (const p of sampleRoute(a, b, 16)) expect(isFiniteVec(p)).toBe(true);
  });

  it("collapses a shared location to a zero-length pulse", () => {
    const a = geoPointToVector(TOKYO);
    const points = sampleRoute(a, a, 8);
    for (const p of points) {
      expect(p.x).toBeCloseTo(a.x, 12);
      expect(p.y).toBeCloseTo(a.y, 12);
      expect(p.z).toBeCloseTo(a.z, 12);
    }
  });
});

describe("marker visibility", () => {
  it("uses the perspective horizon, not the naive z > 0 plane", () => {
    // Just behind the horizon for a camera at distance 3 (horizon z = 1/3).
    expect(isMarkerVisible(vec(0, 0, 0.3), CAMERA_DISTANCE)).toBe(false);
    expect(isMarkerVisible(vec(0, 0, 0.4), CAMERA_DISTANCE)).toBe(true);
    expect(isMarkerVisible(vec(0, 0, -0.9), CAMERA_DISTANCE)).toBe(false);
  });

  it("pulls the camera back only as far as the separation demands", () => {
    const near = recommendedCameraDistance(
      geoPointToVector(TOKYO),
      geoPointToVector({ lat: 35.5, lon: 139.6 }),
    );
    const wide = recommendedCameraDistance(geoPointToVector(SYDNEY), geoPointToVector(BERLIN));
    expect(near).toBe(MIN_CAMERA_DISTANCE);
    expect(wide).toBeGreaterThan(near);
    expect(wide).toBeLessThanOrEqual(MAX_CAMERA_DISTANCE);
  });

  it("caps the distance for an antipodal pair rather than flying away", () => {
    const a = geoPointToVector(TOKYO);
    expect(recommendedCameraDistance(a, vec(-a.x, -a.y, -a.z))).toBe(MAX_CAMERA_DISTANCE);
  });

  it("uses the close default when only one marker exists", () => {
    expect(recommendedCameraDistance(geoPointToVector(TOKYO), null)).toBe(MIN_CAMERA_DISTANCE);
    expect(recommendedCameraDistance(null, null)).toBe(MIN_CAMERA_DISTANCE);
  });
});

describe("desktop orientation", () => {
  const pairs: Array<[string, GeoPoint, GeoPoint]> = [
    ["Tokyo/Berlin", TOKYO, BERLIN],
    ["date line", DATELINE_WEST, DATELINE_EAST],
    ["Sydney/Berlin", SYDNEY, BERLIN],
    ["equatorial", NULL_ISLAND, { lat: 5, lon: 100 }],
  ];

  for (const [name, from, to] of pairs) {
    it(`${name}: keeps both markers visible at Earth's tilt`, () => {
      const local = geoPointToVector(from);
      const remote = geoPointToVector(to);
      const { quat, reason } = targetOrientation({ layout: "desktop", local, remote });
      expect(reason).toBe("both-markers");

      const distance = recommendedCameraDistance(local, remote);
      const lp = quatRotate(quat, local);
      const rp = quatRotate(quat, remote);
      expect(isMarkerVisible(lp, distance)).toBe(true);
      expect(isMarkerVisible(rp, distance)).toBe(true);

      expect(projectedNorthTiltDeg(quat)).toBeCloseTo(AXIAL_TILT_DEG, 6);
    });
  }

  it("faces a single marker and still applies the tilt", () => {
    const local = geoPointToVector(BERLIN);
    const { quat, reason } = targetOrientation({ layout: "desktop", local, remote: null });
    expect(reason).toBe("single-marker");
    expect(quatRotate(quat, local).z).toBeCloseTo(1, 9);
    expect(projectedNorthTiltDeg(quat)).toBeCloseTo(AXIAL_TILT_DEG, 6);
  });

  it("shows a tilted generic globe when neither peer shared a location", () => {
    const { quat, reason } = targetOrientation({ layout: "desktop", local: null, remote: null });
    expect(reason).toBe("no-markers");
    expect(projectedNorthTiltDeg(quat)).toBeCloseTo(AXIAL_TILT_DEG, 6);
  });

  it("holds the previous orientation when north projects to nothing", () => {
    // A marker at the north pole rotates north onto the camera axis, so the
    // projected tilt is undefined.
    const previous = quatFromUnitVectors(vec(0, 0, 1), vec(1, 0, 0));
    const { quat, reason } = targetOrientation({
      layout: "desktop",
      local: geoPointToVector(NORTH_POLE),
      remote: null,
      previous,
    });
    expect(reason).toBe("degenerate-hold");
    expect(quat).toEqual(previous);
  });
});

describe("mobile orientation", () => {
  const pairs: Array<[string, GeoPoint, GeoPoint]> = [
    ["Tokyo/Berlin", TOKYO, BERLIN],
    ["Berlin/Tokyo", BERLIN, TOKYO],
    ["date line", DATELINE_WEST, DATELINE_EAST],
    ["Sydney/Berlin", SYDNEY, BERLIN],
    ["pole pair", { lat: 80, lon: 10 }, { lat: -80, lon: 10 }],
  ];

  for (const [name, from, to] of pairs) {
    it(`${name}: puts this peer left and the other right, for either slot`, () => {
      // Run it twice with the roles swapped: whichever peer is "local" must
      // end up on the left, which is the thing that is easy to get backwards.
      for (const [local, remote] of [
        [geoPointToVector(from), geoPointToVector(to)],
        [geoPointToVector(to), geoPointToVector(from)],
      ]) {
        const { quat } = targetOrientation({ layout: "mobile", local, remote });
        const distance = recommendedCameraDistance(local, remote);
        const lp = quatRotate(quat, local);
        const rp = quatRotate(quat, remote);
        expect(lp.x).toBeLessThan(rp.x);
        // The projected pair is horizontal, not merely ordered.
        expect(Math.abs(rp.y - lp.y)).toBeLessThan(1e-6);
        expect(isMarkerVisible(lp, distance)).toBe(true);
        expect(isMarkerVisible(rp, distance)).toBe(true);
      }
    });
  }

  it("holds a previous orientation for a shared location", () => {
    const same = geoPointToVector(TOKYO);
    const previous = quatFromUnitVectors(vec(0, 0, 1), vec(0, 1, 0));
    const { quat, reason } = targetOrientation({
      layout: "mobile",
      local: same,
      remote: same,
      previous,
    });
    expect(reason).toBe("degenerate-hold");
    expect(quat).toEqual(previous);
  });

  it("faces a shared location when there is no previous orientation", () => {
    const same = geoPointToVector(TOKYO);
    const { quat } = targetOrientation({ layout: "mobile", local: same, remote: same });
    expect(quatRotate(quat, same).z).toBeCloseTo(1, 9);
  });

  it("produces no NaN for a near-antipodal pair", () => {
    const local = geoPointToVector(TOKYO);
    const remote = geoPointToVector(TOKYO_NEAR_ANTIPODE);
    for (const layout of ["desktop", "mobile"] as const) {
      const { quat } = targetOrientation({ layout, local, remote });
      for (const component of [quat.x, quat.y, quat.z, quat.w]) {
        expect(Number.isFinite(component)).toBe(true);
      }
      expect(isFiniteVec(quatRotate(quat, local))).toBe(true);
    }
  });

  it("keeps at least the midpoint visible for an exactly antipodal pair", () => {
    const local = geoPointToVector(TOKYO);
    const remote = vec(-local.x, -local.y, -local.z);
    const { quat } = targetOrientation({ layout: "desktop", local, remote });
    const mid = quatRotate(quat, normalize(routeMidpoint(local, remote))!);
    expect(mid.z).toBeCloseTo(1, 6);
  });
});

describe("quaternion helpers", () => {
  it("rotates from one unit vector onto another", () => {
    const from = geoPointToVector(TOKYO);
    const to = geoPointToVector(BERLIN);
    const rotated = quatRotate(quatFromUnitVectors(from, to), from);
    expect(rotated.x).toBeCloseTo(to.x, 9);
    expect(rotated.y).toBeCloseTo(to.y, 9);
    expect(rotated.z).toBeCloseTo(to.z, 9);
  });

  it("handles identical and opposite vectors without NaN", () => {
    const a = geoPointToVector(TOKYO);
    expect(quatFromUnitVectors(a, a)).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    const opposite = quatRotate(quatFromUnitVectors(a, vec(-a.x, -a.y, -a.z)), a);
    expect(opposite.x).toBeCloseTo(-a.x, 9);
    expect(opposite.y).toBeCloseTo(-a.y, 9);
    expect(opposite.z).toBeCloseTo(-a.z, 9);
  });

  it("slerps the short way even when the targets are far apart", () => {
    const a: Quat = { x: 0, y: 0, z: 0, w: 1 };
    const b = quatFromUnitVectors(vec(0, 0, 1), vec(0, 0, -1));
    // Negating b describes the same rotation; the short path must be the
    // same either way, which is what the sign flip inside slerp guarantees.
    const viaB = quatSlerp(a, b, 0.5);
    const viaNegB = quatSlerp(a, { x: -b.x, y: -b.y, z: -b.z, w: -b.w }, 0.5);
    const v = vec(1, 0, 0);
    const p = quatRotate(viaB, v);
    const q = quatRotate(viaNegB, v);
    expect(p.x).toBeCloseTo(q.x, 9);
    expect(p.y).toBeCloseTo(q.y, 9);
    expect(p.z).toBeCloseTo(q.z, 9);
  });

  it("reaches its endpoints exactly", () => {
    const a = quatFromUnitVectors(vec(0, 0, 1), geoPointToVector(TOKYO));
    const b = quatFromUnitVectors(vec(0, 0, 1), geoPointToVector(BERLIN));
    const start = quatSlerp(a, b, 0);
    const end = quatSlerp(a, b, 1);
    expect(start.w).toBeCloseTo(a.w, 9);
    expect(Math.abs(end.w)).toBeCloseTo(Math.abs(b.w), 9);
  });

  it("stays normalized across the interpolation", () => {
    const a = quatFromUnitVectors(vec(0, 0, 1), geoPointToVector(SYDNEY));
    const b = quatFromUnitVectors(vec(0, 0, 1), geoPointToVector(BERLIN));
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const q = quatSlerp(a, b, Math.min(1, t));
      expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 9);
    }
  });
});

describe("vector helpers", () => {
  it("returns null instead of NaN for a zero-length normalize", () => {
    expect(normalize(vec(0, 0, 0))).toBeNull();
    expect(normalize(vec(Number.NaN, 0, 0))).toBeNull();
  });

  it("cross and dot follow the right-hand rule", () => {
    expect(cross(vec(1, 0, 0), vec(0, 1, 0))).toEqual(vec(0, 0, 1));
    expect(dot(vec(1, 0, 0), vec(0, 1, 0))).toBe(0);
  });

  it("keeps the antipodal epsilon narrower than a degree", () => {
    // A guard on the constant itself: if it ever grows, ordinary long routes
    // would silently start using the fallback plane.
    expect(ANTIPODAL_EPSILON).toBeLessThan(Math.PI / 180);
  });
});
