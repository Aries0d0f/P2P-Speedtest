/**
 * The contract between React and the Three.js scene
 * (06-live-test-visualization 6.2/6.3).
 *
 * Kept in its own module, free of any `three` import, for three reasons: the
 * room route can render its SSR shell without pulling the WebGL chunk,
 * `PeerGlobe.tsx` can type an injected fake factory in a jsdom test, and the
 * only thing crossing the boundary is an immutable frame of plain numbers —
 * no room state, no channels, no measurement bank.
 */

import type { GlobeLayout } from "~/lib/globe-math";
import type { VisualLocation } from "~/lib/test-visualization";

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
 * this browser's local-view colour, so the same stream is violet on the
 * sender's screen and cyan on the receiver's.
 */
export interface GlobeStream {
  key: string;
  fromLocal: boolean;
  /** Receiver-observed Mbps, or `null` when there is no reading yet. Used
   * only for gentle, clamped decoration — never as a claim about packets. */
  mbps: number | null;
  color: number;
}

/** Everything the scene is allowed to know, recomputed by the selector and
 * handed over whole. Treated as immutable by the scene. */
export interface GlobeFrame {
  layout: GlobeLayout;
  localLocation: VisualLocation | null;
  remoteLocation: VisualLocation | null;
  /** Route tube colour; follows the particles. */
  routeColor: number;
  localColor: number;
  remoteColor: number;
  streams: GlobeStream[];
  /** No continuous motion at all: orientation snaps, particles hold. */
  reducedMotion: boolean;
  /** Measurement is live. False during warm-up gaps, finalizing, and after
   * the run — the route goes neutral and the flow stops. */
  running: boolean;
}

/** Where a marker's DOM label should sit, in CSS pixels relative to the
 * canvas box. Delivered through a callback and written with refs, never
 * through React state — this updates every frame. */
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

/** Development-only counters (6.3). Enough to prove the lifecycle budgets in
 * 6.6 without guessing from a screenshot. */
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
   * @param referenceHeight Height of the in-flow placeholder the globe used
   *   to occupy. The globe is drawn at the pixel size it would have had in a
   *   canvas that tall, so filling the screen adds *space around* the globe
   *   rather than magnifying it. The field of view and the dot size both key
   *   off this rather than off `height`.
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

/** Container width at or above Tailwind's `md`. The orientation contract keys
 * off the measured container, never a user-agent string. */
export const DESKTOP_MIN_WIDTH = 768;

export function layoutForWidth(width: number): GlobeLayout {
  return width >= DESKTOP_MIN_WIDTH ? "desktop" : "mobile";
}

export function qualityForWidth(width: number): QualityTier {
  if (width >= DESKTOP_MIN_WIDTH) return "high";
  if (width >= 480) return "medium";
  return "low";
}
