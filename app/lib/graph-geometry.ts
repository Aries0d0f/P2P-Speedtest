/** Pure SVG geometry for the live speed graph. */

import type { Series } from "~/model/speed-series.model";

export const VIEW_WIDTH = 320;
export const VIEW_HEIGHT = 132;
export const PLOT_LEFT = 34;
export const PLOT_RIGHT = VIEW_WIDTH - 6;
export const PLOT_TOP = 10;
export const PLOT_BOTTOM = VIEW_HEIGHT - 20;
const PLOT_WIDTH = PLOT_RIGHT - PLOT_LEFT;
const PLOT_HEIGHT = PLOT_BOTTOM - PLOT_TOP;

/** Keeps a trace that lands exactly on the ceiling inside the plot area
 * (`niceCeiling` deliberately adds no headroom of its own). */
const TOP_MARGIN = 0.06;

/** Minimum x-extent so a stage's first seconds do not stretch across the
 * whole plot and then visibly compress. */
const MIN_SPAN_MS = 10_000;

export function spanSeconds(spanMs: number): number {
  return Math.max(MIN_SPAN_MS, spanMs) / 1000;
}

export function xFor(t: number, spanMs: number): number {
  const span = Math.max(MIN_SPAN_MS, spanMs);
  return PLOT_LEFT + (t / span) * PLOT_WIDTH;
}

export function yFor(mbps: number, ceiling: number): number {
  const fraction = ceiling > 0 ? Math.min(1, Math.max(0, mbps / ceiling)) : 0;
  return PLOT_BOTTOM - fraction * PLOT_HEIGHT * (1 - TOP_MARGIN);
}

export function pointsFor(series: Series, ceiling: number, spanMs: number): string {
  return series.points
    .map((p) => `${xFor(p.t, spanMs).toFixed(1)},${yFor(p.mbps, ceiling).toFixed(1)}`)
    .join(" ");
}

export function axisLabel(value: number): string {
  if (value >= 1000) return `${value / 1000}k`;
  return `${value}`;
}
