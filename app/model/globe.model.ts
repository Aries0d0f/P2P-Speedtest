/**
 * The contract between React and the Three.js scene (6.2/6.3), plus the plain
 * vector/quaternion types the pure globe math works in.
 *
 * Free of any `three` import so the room route can render its SSR shell
 * without pulling the WebGL chunk, and `PeerGlobe.tsx` can type an injected
 * fake factory in a jsdom test. The only thing crossing the boundary is an
 * immutable frame of plain numbers — no room state, no channels, no bank.
 *
 * Coordinate convention (camera on +Z):
 *
 *   x = cos(lat) * sin(lon)
 *   y = sin(lat)                 // +y is the north pole
 *   z = cos(lat) * cos(lon)      // lon 0 faces the camera
 */

import type { GeoPoint } from "./geo.model";

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

export type GlobeLayout = "desktop" | "mobile";

export type QualityTier = "high" | "medium" | "low";

export interface QualitySettings {
  /** Dots in the world point cloud. */
  points: number;
  /** Particles per active stream. */
  particlesPerStream: number;
  /** Segments along the route tube. */
  routeSegments: number;
  /** Upper bound on `devicePixelRatio`; a phone must not allocate a
   * desktop-resolution back buffer. */
  maxPixelRatio: number;
  antialias: boolean;
}

export const QUALITY: Record<QualityTier, QualitySettings> = {
  high: { points: 200_000, particlesPerStream: 40, routeSegments: 128, maxPixelRatio: 4, antialias: true },
  medium: { points: 100_000, particlesPerStream: 28, routeSegments: 96, maxPixelRatio: 2, antialias: true },
  low: { points: 50_000, particlesPerStream: 18, routeSegments: 48, maxPixelRatio: 1.5, antialias: false },
};

/**
 * One packet stream, in *physical* terms. `fromLocal` is the direction the
 * bytes actually travel, so both browsers animate the same arrow; `color` is
 * this browser's local-view colour.
 */
export interface GlobeStream {
  key: string;
  fromLocal: boolean;
  /** Receiver-observed Mbps, or `null` when there is no reading yet. Used only
   * for gentle, clamped decoration — never as a claim about packets. */
  mbps: number | null;
  color: number;
}

/** Everything the scene is allowed to know, recomputed by the selector and
 * handed over whole. Treated as immutable by the scene. */
export interface GlobeFrame {
  layout: GlobeLayout;
  localLocation: GeoPoint | null;
  remoteLocation: GeoPoint | null;
  /** Route tube colour; follows the particles. */
  routeColor: number;
  localColor: number;
  remoteColor: number;
  streams: GlobeStream[];
  /** No continuous motion at all: orientation snaps, particles hold. */
  reducedMotion: boolean;
  /** Measurement is live. False during warm-up gaps, finalizing, and after the
   * run — the route goes neutral and the flow stops. */
  running: boolean;
}

/** Where a marker's DOM label should sit, in CSS pixels relative to the canvas
 * box. Delivered through a callback and written with refs, never through React
 * state — this updates every frame. */
export interface LabelPlacement {
  x: number;
  y: number;
  /** In front of the globe rather than behind it. */
  visible: boolean;
}

export interface LabelPlacements {
  local: LabelPlacement | null;
  remote: LabelPlacement | null;
}

/** Development-only counters (6.3). */
export interface GlobeDiagnostics {
  drawCalls: number;
  geometries: number;
  textures: number;
  programs: number;
  rafActive: boolean;
  quality: QualityTier;
  cameraDistance: number;
  /** Projected marker depths in view space; > horizon means visible. */
  localDepth: number | null;
  remoteDepth: number | null;
  projectedNorthTiltDeg: number | null;
  /** Why the current orientation was chosen. */
  orientationReason: string;
  frames: number;
}

export interface GlobeScene {
  /** Apply a new immutable frame. Cheap: only geometry affected by changed
   * coordinates is rebuilt. */
  update(frame: GlobeFrame): void;
  /**
   * @param width  Canvas box width in CSS pixels — the viewport, since the
   *   canvas is a fixed full-screen layer.
   * @param height Canvas box height in CSS pixels.
   * @param referenceHeight Height of the in-flow placeholder the globe used to
   *   occupy. The globe is drawn at the pixel size it would have had in a
   *   canvas that tall, so filling the screen adds *space around* the globe
   *   rather than magnifying it. Field of view and dot size both key off this
   *   rather than off `height`.
   */
  resize(width: number, height: number, referenceHeight: number): void;
  /** Page Visibility / off-screen: stops the visual clock. Measurement is
   * unaffected; resuming renders the current frame rather than replaying. */
  setActive(active: boolean): void;
  diagnostics(): GlobeDiagnostics;
  dispose(): void;
}

export interface GlobeSceneOptions {
  canvas: HTMLCanvasElement;
  quality: QualityTier;
  /** Called every frame with the projected label positions. */
  onLabels(placements: LabelPlacements): void;
  /**
   * An imperative failure after mount — a RAF exception, a lost context that
   * could not be rebuilt, or a failed asset load. React error boundaries
   * cannot see these, so the scene reports them itself. The scene has already
   * stopped and disposed its own work by the time this fires.
   */
  onError(error: unknown): void;
}

export type GlobeSceneFactory = (options: GlobeSceneOptions) => Promise<GlobeScene>;

/**
 * Container width at or above Tailwind's `sm`, the point where the orientation
 * contract switches from the mobile self-left/peer-right roll to a tilted
 * Earth. Keyed off the measured container, never a user-agent string.
 *
 * Deliberately *below* the `max-w-3xl` (768px) cap the room puts on the
 * dashboard column. A threshold equal to that cap is one the container can only
 * ever meet exactly and never clear, so a desktop browser narrower than about
 * 800px — cap plus the page's own `px-4` — silently got the mobile roll. `sm`
 * leaves real headroom on both sides: no phone in portrait reaches it, and any
 * window wide enough to be a desktop window clears it.
 */
export const DESKTOP_MIN_WIDTH = 640;

/** Separate from the orientation threshold on purpose: a 640px column should
 * get the desktop *arrangement* without also being handed a 200k-point cloud
 * and a 4x back buffer. */
export const HIGH_QUALITY_MIN_WIDTH = 768;
