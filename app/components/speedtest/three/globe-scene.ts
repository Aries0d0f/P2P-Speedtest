/** Width-driven choices for the globe scene. The orientation and quality
 * contracts key off the measured container, never a user-agent string. */

import {
  DESKTOP_MIN_WIDTH,
  HIGH_QUALITY_MIN_WIDTH,
  type GlobeLayout,
  type QualityTier,
} from "~/model/globe.model";

export function layoutForWidth(width: number): GlobeLayout {
  return width >= DESKTOP_MIN_WIDTH ? "desktop" : "mobile";
}

export function qualityForWidth(width: number): QualityTier {
  if (width >= HIGH_QUALITY_MIN_WIDTH) return "high";
  if (width >= 480) return "medium";
  return "low";
}
