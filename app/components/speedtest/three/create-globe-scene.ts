/**
 * The browser-only Three.js peer globe (06-live-test-visualization 6.2, 6.3).
 *
 * This module is imported dynamically and only by `PeerGlobe.tsx`, so the
 * `three` chunk and the land mask load with the live dashboard and never with
 * the home or results routes.
 *
 * Two rules shape almost every decision below:
 *
 * - **Nothing is allocated per frame.** Geometry is rebuilt only when
 *   validated coordinates change; the render loop writes into preallocated
 *   typed arrays and scratch vectors. An attractive loop that costs
 *   main-thread time would perturb the very throughput test it is drawing.
 * - **Every failure is local.** A renderer that will not create, a mask that
 *   will not load, a lost context, a throw inside RAF: each stops and
 *   disposes this scene and reports through `onError`, and none of them can
 *   reach the room state machine.
 */

import * as THREE from "three";

import maskUrl from "~/assets/world-land-mask.png";
import {
  IDENTITY_QUAT,
  MIN_CAMERA_DISTANCE,
  clamp,
  fibonacciSphere,
  latLonToVector,
  planRoute,
  projectedNorthTiltDeg,
  recommendedCameraDistance,
  routePointAt,
  targetOrientation,
  vectorToUv,
  type Quat,
  type RoutePlan,
  type Vec3,
} from "~/lib/globe-math";
import type { VisualLocation } from "~/lib/test-visualization";

import {
  QUALITY,
  type GlobeDiagnostics,
  type GlobeFrame,
  type GlobeScene,
  type GlobeSceneOptions,
  type LabelPlacement,
  type LabelPlacements,
} from "./globe-scene";

const CAMERA_FOV = 38;
/** Short of the degenerate 180°, where a perspective projection blows up. */
const MAX_CAMERA_FOV = 150;
const OCEAN_COLOR = new THREE.Color(0x1b3350);
const LAND_COLOR = new THREE.Color(0x6ea8d8);
const GLOBE_INTERIOR = 0x060a14;
const MARKER_RADIUS = 1.012;
const ROUTE_TUBE_RADIUS = 0.008;

/** Decorative only, and deliberately narrow: the difference between a slow
 * and a fast link is visible, but no viewer could mistake a dot for a packet
 * or read a speed off the animation. */
const MIN_STREAM_SPEED = 0.09; // route-lengths per second
const MAX_STREAM_SPEED = 0.42;
const SPEED_REFERENCE_MBPS = 400;

/** Seconds to reach a new orientation. Long enough to read as a deliberate
 * camera move, short enough that a late geo enrichment is not annoying. */
const ORIENTATION_SECONDS = 1.1;
const CAMERA_LERP_PER_SECOND = 2.2;

function sameLocation(a: VisualLocation | null, b: VisualLocation | null): boolean {
  if (a === null || b === null) return a === b;
  return a.lat === b.lat && a.lon === b.lon;
}

function toThree(v: Vec3): THREE.Vector3 {
  return new THREE.Vector3(v.x, v.y, v.z);
}

/**
 * Reads the land mask once into a byte-per-pixel lookup. Sampling on the CPU
 * rather than in a shader lets a single `THREE.Points` carry a per-vertex
 * "is land" attribute, so land dots differ in both colour and size while the
 * whole world stays one draw call.
 */
async function loadLandMask(): Promise<{ width: number; height: number; data: Uint8Array }> {
  const response = await fetch(maskUrl);
  if (!response.ok) throw new Error(`land mask ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("2d context unavailable");
    ctx.drawImage(bitmap, 0, 0);
    const rgba = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const data = new Uint8Array(bitmap.width * bitmap.height);
    for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4];
    return { width: bitmap.width, height: bitmap.height, data };
  } finally {
    bitmap.close();
  }
}

const IDLE_FRAME: GlobeFrame = {
  layout: "desktop",
  localLocation: null,
  remoteLocation: null,
  routeColor: 0x64748b,
  localColor: 0x94a3b8,
  remoteColor: 0x94a3b8,
  streams: [],
  reducedMotion: false,
  running: false,
};

export async function createGlobeScene(options: GlobeSceneOptions): Promise<GlobeScene> {
  const { canvas, quality, onLabels, onError } = options;
  const settings = QUALITY[quality];

  // Load the mask before touching WebGL: a mask failure then costs nothing to
  // clean up, and the caller gets the accessible fallback either way.
  const mask = await loadLandMask();

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: settings.antialias,
      powerPreference: "low-power",
    });
  } catch (error) {
    throw new Error("WebGL 2 renderer unavailable", { cause: error });
  }
  renderer.setClearAlpha(0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 100);
  camera.position.set(0, 0, MIN_CAMERA_DISTANCE);

  const earth = new THREE.Group();
  scene.add(earth);

  // --- owned GPU resources, disposed together ------------------------------
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const track = <T extends THREE.BufferGeometry | THREE.Material>(resource: T): T => {
    if (resource instanceof THREE.BufferGeometry) geometries.push(resource);
    else materials.push(resource);
    return resource;
  };

  // --- dotted world --------------------------------------------------------
  const cloudPoints = fibonacciSphere(settings.points);
  const cloudPositions = new Float32Array(cloudPoints.length * 3);
  const cloudColors = new Float32Array(cloudPoints.length * 3);
  const cloudSizes = new Float32Array(cloudPoints.length);
  for (let i = 0; i < cloudPoints.length; i++) {
    const p = cloudPoints[i];
    cloudPositions[i * 3] = p.x;
    cloudPositions[i * 3 + 1] = p.y;
    cloudPositions[i * 3 + 2] = p.z;

    const uv = vectorToUv(p);
    const mx = Math.min(mask.width - 1, Math.floor(uv.u * mask.width));
    const my = Math.min(mask.height - 1, Math.floor(uv.v * mask.height));
    const isLand = mask.data[my * mask.width + mx] > 127;

    const color = isLand ? LAND_COLOR : OCEAN_COLOR;
    cloudColors[i * 3] = color.r;
    cloudColors[i * 3 + 1] = color.g;
    cloudColors[i * 3 + 2] = color.b;
    cloudSizes[i] = isLand ? 0.2 : 0.01;
  }

  const cloudGeometry = track(new THREE.BufferGeometry());
  cloudGeometry.setAttribute("position", new THREE.BufferAttribute(cloudPositions, 3));
  cloudGeometry.setAttribute("color", new THREE.BufferAttribute(cloudColors, 3));
  cloudGeometry.setAttribute("aSize", new THREE.BufferAttribute(cloudSizes, 1));

  // A tiny shader rather than PointsMaterial: it keeps dots the same apparent
  // size regardless of DPR and renders them round instead of square, in one
  // draw call for the whole world.
  const cloudMaterial = track(
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uScale: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute float aSize;
        uniform float uScale;
        varying vec3 vColor;
        void main() {
          vColor = color;
          vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uScale / max(0.4, -viewPosition.z);
          gl_Position = projectionMatrix * viewPosition;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        void main() {
          vec2 offset = gl_PointCoord - vec2(0.5);
          float d = dot(offset, offset);
          if (d > 0.25) discard;
          gl_FragColor = vec4(vColor, 1.0 - smoothstep(0.16, 0.25, d));
        }
      `,
      vertexColors: true,
    }),
  );
  const cloud = new THREE.Points(cloudGeometry, cloudMaterial);
  earth.add(cloud);

  // Occludes the far-side dots, markers and route so the globe reads as solid.
  const interiorGeometry = track(new THREE.SphereGeometry(0.978, 48, 32));
  const interiorMaterial = track(new THREE.MeshBasicMaterial({ color: GLOBE_INTERIOR }));
  earth.add(new THREE.Mesh(interiorGeometry, interiorMaterial));

  // Purely local, synthetic rim light — no environment map or external texture.
  const atmosphereGeometry = track(new THREE.SphereGeometry(1.13, 48, 32));
  const atmosphereMaterial = track(
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        varying vec3 vNormal;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vNormal;
        void main() {
          float rim = pow(1.0 - abs(vNormal.z), 3.0);
          gl_FragColor = vec4(0.35, 0.62, 0.95, rim * 0.45);
        }
      `,
    }),
  );
  scene.add(new THREE.Mesh(atmosphereGeometry, atmosphereMaterial));

  // --- markers -------------------------------------------------------------
  const markerGeometry = track(new THREE.SphereGeometry(0.022, 16, 12));
  const haloGeometry = track(new THREE.RingGeometry(0.032, 0.046, 24));

  function makeMarker(): { group: THREE.Group; core: THREE.MeshBasicMaterial; halo: THREE.MeshBasicMaterial } {
    const core = track(new THREE.MeshBasicMaterial({ color: 0xffffff })) as THREE.MeshBasicMaterial;
    const halo = track(
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
    ) as THREE.MeshBasicMaterial;
    const group = new THREE.Group();
    group.add(new THREE.Mesh(markerGeometry, core));
    const ring = new THREE.Mesh(haloGeometry, halo);
    group.add(ring);
    group.visible = false;
    earth.add(group);
    return { group, core, halo };
  }

  const localMarker = makeMarker();
  const remoteMarker = makeMarker();

  // --- route ---------------------------------------------------------------
  const routeMaterial = track(
    new THREE.MeshBasicMaterial({ color: 0x64748b, transparent: true, opacity: 0.85 }),
  ) as THREE.MeshBasicMaterial;
  let routeMesh: THREE.Mesh | null = null;
  let routeGeometry: THREE.TubeGeometry | null = null;
  let routeCurve: THREE.CatmullRomCurve3 | null = null;
  let routePlan: RoutePlan | null = null;

  function disposeRoute() {
    if (routeMesh) earth.remove(routeMesh);
    routeGeometry?.dispose();
    routeMesh = null;
    routeGeometry = null;
    routeCurve = null;
    routePlan = null;
  }

  function buildRoute(from: Vec3, to: Vec3) {
    disposeRoute();
    routePlan = planRoute(from, to);
    if (routePlan.kind === "shared-location") return; // one marker, no arc
    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= settings.routeSegments; i++) {
      points.push(toThree(routePointAt(from, to, i / settings.routeSegments, routePlan)));
    }
    routeCurve = new THREE.CatmullRomCurve3(points, false, "centripetal", 0);
    // A tube, not `LineBasicMaterial`: line width above 1 is not portable
    // across WebGL implementations and silently renders hairline on most.
    routeGeometry = new THREE.TubeGeometry(routeCurve, settings.routeSegments, ROUTE_TUBE_RADIUS, 6, false);
    routeMesh = new THREE.Mesh(routeGeometry, routeMaterial);
    earth.add(routeMesh);
  }

  // --- particles -----------------------------------------------------------
  // One preallocated pool per direction; a stage change retargets it rather
  // than rebuilding anything.
  const POOL = settings.particlesPerStream;

  interface Pool {
    points: THREE.Points;
    positions: Float32Array;
    material: THREE.PointsMaterial;
    /** Phase in [0, 1) per particle, advanced in place. */
    phase: Float32Array;
    active: boolean;
    fromLocal: boolean;
    speed: number;
    /** Lateral offset so the two duplex streams do not overlap. */
    lane: number;
  }

  function makePool(lane: number): Pool {
    const positions = new Float32Array(POOL * 3);
    const geometry = track(new THREE.BufferGeometry());
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const material = track(
      new THREE.PointsMaterial({
        color: 0xffffff,
        size: 0.028,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
      }),
    ) as THREE.PointsMaterial;
    const points = new THREE.Points(geometry, material);
    points.visible = false;
    points.frustumCulled = false;
    earth.add(points);
    const phase = new Float32Array(POOL);
    for (let i = 0; i < POOL; i++) phase[i] = i / POOL;
    return { points, positions, material, phase, active: false, fromLocal: true, speed: MIN_STREAM_SPEED, lane };
  }

  const pools: Pool[] = [makePool(0), makePool(1)];

  // --- orientation ---------------------------------------------------------
  let currentQuat = new THREE.Quaternion();
  let targetQuat = new THREE.Quaternion();
  let orientationReason = "no-markers";
  let stableQuat: Quat = IDENTITY_QUAT;
  let targetCameraDistance = MIN_CAMERA_DISTANCE;

  // --- frame state ---------------------------------------------------------
  let frame: GlobeFrame = IDLE_FRAME;
  let localVec: Vec3 | null = null;
  let remoteVec: Vec3 | null = null;
  let width = 1;
  let height = 1;
  /** Height of the in-flow placeholder; sets the globe's pixel size. */
  let referenceHeight = 1;
  let pixelRatio = 1;
  let active = true;
  let disposed = false;
  let contextLost = false;
  let rafId: number | null = null;
  let lastTime = 0;
  let frames = 0;

  // Scratch objects reused every frame — the "no per-frame allocation" rule.
  const scratchVec = new THREE.Vector3();
  const scratchQuat = new THREE.Quaternion();
  const localPlacement: LabelPlacement = { x: 0, y: 0, visible: false };
  const remotePlacement: LabelPlacement = { x: 0, y: 0, visible: false };
  const placements: LabelPlacements = { local: null, remote: null };

  function applyOrientation(snap: boolean) {
    const result = targetOrientation({
      layout: frame.layout,
      local: localVec,
      remote: remoteVec,
      previous: stableQuat,
    });
    orientationReason = result.reason;
    stableQuat = result.quat;
    targetQuat.set(result.quat.x, result.quat.y, result.quat.z, result.quat.w);
    targetCameraDistance = recommendedCameraDistance(localVec, remoteVec);
    if (snap) {
      currentQuat.copy(targetQuat);
      earth.quaternion.copy(currentQuat);
      camera.position.z = targetCameraDistance;
    }
  }

  function applyLocations(next: GlobeFrame) {
    localVec = next.localLocation ? latLonToVector(next.localLocation) : null;
    remoteVec = next.remoteLocation ? latLonToVector(next.remoteLocation) : null;

    localMarker.group.visible = localVec !== null;
    if (localVec) {
      localMarker.group.position.set(localVec.x, localVec.y, localVec.z).multiplyScalar(MARKER_RADIUS);
      localMarker.group.lookAt(0, 0, 0);
    }
    remoteMarker.group.visible = remoteVec !== null;
    if (remoteVec) {
      remoteMarker.group.position.set(remoteVec.x, remoteVec.y, remoteVec.z).multiplyScalar(MARKER_RADIUS);
      remoteMarker.group.lookAt(0, 0, 0);
    }

    if (localVec && remoteVec) buildRoute(localVec, remoteVec);
    else disposeRoute();
  }

  function applyStreams(next: GlobeFrame) {
    const usable = routeCurve !== null && next.running && next.streams.length > 0;
    for (let i = 0; i < pools.length; i++) {
      const pool = pools[i];
      const stream = usable ? next.streams[i] : undefined;
      pool.active = stream !== undefined;
      pool.points.visible = pool.active && !next.reducedMotion;
      if (!stream) continue;
      pool.fromLocal = stream.fromLocal;
      pool.material.color.setHex(stream.color);
      // Monotonic, gently mapped, and hard-clamped at both ends. A 10x faster
      // link looks livelier; it does not look 10x faster.
      const mbps = stream.mbps === null ? 0 : Math.max(0, stream.mbps);
      const t = Math.sqrt(Math.min(1, mbps / SPEED_REFERENCE_MBPS));
      pool.speed = MIN_STREAM_SPEED + t * (MAX_STREAM_SPEED - MIN_STREAM_SPEED);
    }
  }

  function writeParticles(pool: Pool) {
    const curve = routeCurve;
    if (!curve) return;
    for (let i = 0; i < POOL; i++) {
      const t = pool.fromLocal ? pool.phase[i] : 1 - pool.phase[i];
      curve.getPointAt(clamp(t, 0, 1), scratchVec);
      // Lane offset lifts the second duplex stream slightly so two opposing
      // flows read as two tracks rather than one jittery line.
      const lift = 1 + pool.lane * 0.035;
      pool.positions[i * 3] = scratchVec.x * lift;
      pool.positions[i * 3 + 1] = scratchVec.y * lift;
      pool.positions[i * 3 + 2] = scratchVec.z * lift;
    }
    pool.points.geometry.attributes.position.needsUpdate = true;
  }

  function project(vec: Vec3 | null, into: LabelPlacement): LabelPlacement | null {
    if (!vec) return null;
    scratchVec.set(vec.x, vec.y, vec.z).multiplyScalar(MARKER_RADIUS).applyQuaternion(earth.quaternion);
    const depth = scratchVec.z;
    scratchVec.project(camera);
    into.x = (scratchVec.x * 0.5 + 0.5) * width;
    into.y = (-scratchVec.y * 0.5 + 0.5) * height;
    into.visible = depth > 1 / Math.max(1.0001, camera.position.z);
    return into;
  }

  function renderOnce(deltaSeconds: number) {
    if (contextLost) return;

    if (frame.reducedMotion) {
      earth.quaternion.copy(targetQuat);
      currentQuat.copy(targetQuat);
      camera.position.z = targetCameraDistance;
    } else {
      const step = Math.min(1, deltaSeconds / ORIENTATION_SECONDS);
      // `slerp` on the live quaternion, so the globe eases to the target and
      // then holds it. There is no idle spin: a marker that arrived in view
      // stays in view.
      currentQuat.slerp(targetQuat, step);
      earth.quaternion.copy(currentQuat);
      camera.position.z +=
        (targetCameraDistance - camera.position.z) * Math.min(1, deltaSeconds * CAMERA_LERP_PER_SECOND);
    }

    if (!frame.reducedMotion) {
      for (const pool of pools) {
        if (!pool.active) continue;
        for (let i = 0; i < POOL; i++) {
          pool.phase[i] = (pool.phase[i] + pool.speed * deltaSeconds) % 1;
        }
        writeParticles(pool);
      }
    }

    renderer.render(scene, camera);
    frames++;

    placements.local = project(localVec, localPlacement);
    placements.remote = project(remoteVec, remotePlacement);
    onLabels(placements);
  }

  /** True once the scene has reached its target and has nothing left to
   * animate — the loop parks rather than burning frames on a still image. */
  function isSettled(): boolean {
    if (frame.reducedMotion) return true;
    if (pools.some((p) => p.active)) return false;
    if (Math.abs(camera.position.z - targetCameraDistance) > 1e-3) return false;
    scratchQuat.copy(currentQuat);
    return scratchQuat.angleTo(targetQuat) < 1e-4;
  }

  function loop(time: number) {
    rafId = null;
    if (disposed) return;
    try {
      const delta = lastTime === 0 ? 1 / 60 : Math.min(0.1, (time - lastTime) / 1000);
      lastTime = time;
      renderOnce(delta);
      if (active && !isSettled()) schedule();
      else rafId = null;
    } catch (error) {
      // A throw inside RAF is invisible to a React error boundary, so the
      // scene tears itself down and reports through the same local fallback.
      stop();
      onError(error);
    }
  }

  function schedule() {
    if (disposed || rafId !== null || !active || contextLost) return;
    rafId = requestAnimationFrame(loop);
  }

  /** Draw exactly one frame — used when resuming from a hidden tab, so the
   * current state appears immediately without replaying missed animation. */
  function renderStatic() {
    if (disposed || contextLost) return;
    try {
      lastTime = 0;
      renderOnce(1 / 60);
    } catch (error) {
      stop();
      onError(error);
    }
  }

  function stop() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  // --- context loss --------------------------------------------------------
  function handleContextLost(event: Event) {
    event.preventDefault(); // required for `webglcontextrestored` to ever fire
    contextLost = true;
    stop();
    onError(new Error("WebGL context lost"));
  }

  function handleContextRestored() {
    if (disposed) return;
    contextLost = false;
    // Idempotent by construction: the scene graph and all typed arrays
    // survived, so restoring means re-uploading and drawing the *current*
    // frame once. Repeated events cannot create a second renderer or loop.
    try {
      renderer.resetState();
      applyOrientation(true);
      renderStatic();
      schedule();
    } catch (error) {
      onError(error);
    }
  }

  canvas.addEventListener("webglcontextlost", handleContextLost as EventListener);
  canvas.addEventListener("webglcontextrestored", handleContextRestored);

  // --- public surface ------------------------------------------------------
  const globeScene: GlobeScene = {
    update(next: GlobeFrame) {
      if (disposed) return;
      const previous = frame;
      frame = next;

      const locationsChanged =
        !sameLocation(previous.localLocation, next.localLocation) ||
        !sameLocation(previous.remoteLocation, next.remoteLocation);
      if (locationsChanged) applyLocations(next);

      localMarker.core.color.setHex(next.localColor);
      localMarker.halo.color.setHex(next.localColor);
      remoteMarker.core.color.setHex(next.remoteColor);
      remoteMarker.halo.color.setHex(next.remoteColor);
      // Colour follows the transfer without remeshing the tube.
      routeMaterial.color.setHex(next.routeColor);
      routeMaterial.opacity = next.running ? 0.9 : 0.45;

      applyStreams(next);

      if (locationsChanged || previous.layout !== next.layout) {
        applyOrientation(next.reducedMotion);
      }
      if (next.reducedMotion) renderStatic();
      else schedule();
    },

    resize(nextWidth: number, nextHeight: number, nextReferenceHeight: number) {
      if (disposed) return;
      width = Math.max(1, nextWidth);
      height = Math.max(1, nextHeight);
      referenceHeight = Math.max(1, nextReferenceHeight);
      pixelRatio = Math.min(
        typeof devicePixelRatio === "number" ? devicePixelRatio : 1,
        settings.maxPixelRatio,
      );
      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;

      // Keep the globe's *pixel* size fixed while the canvas grows to fill the
      // screen. A sphere's projected half-height is
      //
      //     p = (r / d) * H / (2 * tan(fov / 2))
      //
      // so holding `H / tan(fov / 2)` constant holds `p` constant. Widening
      // the field of view in step with the canvas therefore reveals more empty
      // space around the globe instead of magnifying it. Clamped short of the
      // degenerate 180° where the projection blows up.
      const baseHalf = Math.tan(((CAMERA_FOV / 2) * Math.PI) / 180);
      const half = Math.atan(baseHalf * (height / referenceHeight));
      camera.fov = Math.min(MAX_CAMERA_FOV, (half * 2 * 180) / Math.PI);
      camera.updateProjectionMatrix();

      // `gl_PointSize` is in device pixels, so the dots key off the reference
      // height for the same reason: they belong to the globe, not the canvas.
      cloudMaterial.uniforms.uScale.value = referenceHeight * pixelRatio * 0.055;
      renderStatic();
    },

    setActive(nextActive: boolean) {
      if (disposed || active === nextActive) return;
      active = nextActive;
      if (active) {
        lastTime = 0;
        renderStatic();
        schedule();
      } else {
        stop();
      }
    },

    diagnostics(): GlobeDiagnostics {
      const info = renderer.info;
      return {
        drawCalls: info.render.calls,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        programs: info.programs?.length ?? 0,
        rafActive: rafId !== null,
        quality,
        cameraDistance: camera.position.z,
        localDepth: localVec ? depthOf(localVec) : null,
        remoteDepth: remoteVec ? depthOf(remoteVec) : null,
        projectedNorthTiltDeg: projectedNorthTiltDeg({
          x: earth.quaternion.x,
          y: earth.quaternion.y,
          z: earth.quaternion.z,
          w: earth.quaternion.w,
        }),
        orientationReason,
        frames,
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      canvas.removeEventListener("webglcontextlost", handleContextLost as EventListener);
      canvas.removeEventListener("webglcontextrestored", handleContextRestored);
      disposeRoute();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      renderer.dispose();
      // Frees the GPU context immediately rather than waiting for GC — the
      // browser only allows a handful of live contexts, and StrictMode
      // mount/unmount/remount would otherwise exhaust them.
      renderer.forceContextLoss();
      scene.clear();
      earth.clear();
    },
  };

  function depthOf(v: Vec3): number {
    scratchVec.set(v.x, v.y, v.z).applyQuaternion(earth.quaternion);
    return scratchVec.z;
  }

  // Nothing is animated until the first `update`/`resize`, but the static
  // globe should be on screen the moment the chunk lands.
  applyOrientation(true);
  return globeScene;
}
