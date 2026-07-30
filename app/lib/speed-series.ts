/**
 * The bounded, run-scoped series behind the live graph and gauge
 * (06-live-test-visualization 6.4).
 *
 * A pure reducer, deliberately: the widgets animate, but what they animate is
 * decided here, where duplication, stage boundaries, run resets and the
 * y-scale can be reasoned about and tested without a DOM or a clock. Time is
 * an input, never read from `Date.now()`.
 *
 * Three properties matter most:
 *
 * - **Bounded.** Memory and DOM stay flat across a long run: each series
 *   decimates in place rather than growing, and a run can only ever produce
 *   four series (one per directional stage, two for duplex).
 * - **Stage-separated.** Each `(stage, edge)` is its own series, so no
 *   misleading diagonal ever connects the end of one stage to the start of
 *   the next.
 * - **Monotonic scale.** The ceiling may rise during a run but never falls,
 *   so an earlier stage stays visually comparable with a later one.
 */

import type { StageId } from "~/lib/stage";
import type { TransferChannel, TransferToken } from "~/lib/test-visualization";

/** Points kept per series before decimation halves the resolution. At Phase
 * 4's four updates a second, this is a full minute of a single stage. */
export const MAX_POINTS_PER_SERIES = 240;

export interface SeriesPoint {
  /** Milliseconds since this *series'* first sample — not the run's. Each
   * stage is plotted from its own zero so the three overlay for comparison
   * instead of being strung out along the run with dead gaps between them. */
  t: number;
  mbps: number;
}

export interface Series {
  /** `edgeKey(stageId, receiverSlot)` — unique within a run. */
  key: string;
  stageId: StageId;
  role: "receive" | "send";
  token: TransferToken;
  label: string;
  /** Wall clock of this series' first sample; the origin of its own `t`. */
  originMs: number;
  points: SeriesPoint[];
  /** Every `stride`-th sample is kept; doubles when the buffer fills. */
  stride: number;
  /** Samples seen, including those decimated away. */
  seen: number;
  /** Dedup guard: the last snapshot identity folded in. */
  lastSampleKey: string | null;
}

export interface SpeedSeriesState {
  runId: string | null;
  /** In first-sample order, so stages read left to right. */
  series: Series[];
  /** Monotonic "nice" y-axis ceiling in Mbps. */
  ceiling: number;
  /** The longest series' duration — the shared x-axis extent. Monotonic, so
   * a later short stage never squeezes an earlier long one. */
  spanMs: number;
}

const INITIAL_CEILING = 1;

export function emptySpeedSeries(): SpeedSeriesState {
  return { runId: null, series: [], ceiling: INITIAL_CEILING, spanMs: 0 };
}

/**
 * The smallest 1/2/5 × 10ⁿ value at or above `mbps`.
 *
 * No extra headroom is baked in: the coarse steps already leave plenty for
 * any real reading, and padding the number would push, say, 180 Mbps onto a
 * 500 Mbps axis. The graph reserves its own top margin so a trace that lands
 * exactly on the ceiling is still drawn inside the plot area.
 */
export function niceCeiling(mbps: number): number {
  if (!Number.isFinite(mbps) || mbps <= 0) return INITIAL_CEILING;
  const exponent = Math.floor(Math.log10(mbps));
  for (const decade of [exponent, exponent + 1]) {
    for (const step of [1, 2, 5]) {
      const candidate = step * 10 ** decade;
      // Tolerate float drift so 10 ** 2 * 1 does not lose to 99.99999999999.
      if (candidate >= mbps * (1 - 1e-12)) return candidate;
    }
  }
  return 10 ** (exponent + 2);
}

export interface RecordInput {
  runId: string | null;
  /** A monotonic reading, e.g. `performance.now()`. */
  nowMs: number;
  channels: readonly TransferChannel[];
}

/**
 * Folds one render's worth of channels into the series.
 *
 * Returns the *same* state object when nothing changed, so a React consumer
 * can bail out of a re-render cheaply. Channels without a reading contribute
 * nothing — a missing sample is never recorded as zero.
 */
export function recordSample(state: SpeedSeriesState, input: RecordInput): SpeedSeriesState {
  // A new run wipes everything: no earlier run's trace, ceiling, or origin can
  // survive into the next one.
  const base = state.runId === input.runId ? state : { ...emptySpeedSeries(), runId: input.runId };

  let next: SpeedSeriesState | null = null;
  const mutate = (): SpeedSeriesState => (next ??= { ...base, series: [...base.series] });

  for (const channel of input.channels) {
    if (channel.mbps === null || !Number.isFinite(channel.mbps) || channel.mbps < 0) continue;

    // Look before copying, so a render that carries nothing new returns the
    // identical state object and the consumer can skip its work entirely.
    const source = next ?? base;
    const index = source.series.findIndex((s) => s.key === channel.key);
    const existing = index >= 0 ? source.series[index] : null;

    // The same Phase 4 progress event re-rendered (a latency tick, a resize):
    // not a new observation, so not a new point.
    if (existing && channel.sampleKey !== null && existing.lastSampleKey === channel.sampleKey) {
      continue;
    }

    const draft = mutate();
    const series = existing
      ? appendPoint(existing, input.nowMs, channel.mbps, channel.sampleKey)
      : startSeries(channel, input.nowMs);

    if (index >= 0) draft.series[index] = series;
    else draft.series.push(series);

    draft.spanMs = Math.max(draft.spanMs, latest(series)?.t ?? 0);
    // Monotonic: rises for a faster reading, never falls back for a slower one.
    draft.ceiling = Math.max(draft.ceiling, niceCeiling(channel.mbps));
  }

  return next ?? base;
}

function startSeries(channel: TransferChannel, nowMs: number): Series {
  return {
    key: channel.key,
    stageId: channel.stageId,
    role: channel.role,
    token: channel.token,
    label: channel.label,
    originMs: nowMs,
    points: [{ t: 0, mbps: channel.mbps as number }],
    stride: 1,
    seen: 1,
    lastSampleKey: channel.sampleKey,
  };
}

function appendPoint(series: Series, nowMs: number, mbps: number, sampleKey: string | null): Series {
  const t = Math.max(0, nowMs - series.originMs);
  const seen = series.seen + 1;
  let stride = series.stride;
  let points = series.points;

  // Only every `stride`-th sample is kept, so a long stage loses resolution
  // rather than growing without bound. The newest sample is always kept, so
  // the live end of the trace never lags.
  if (points.length >= MAX_POINTS_PER_SERIES) {
    stride *= 2;
    points = points.filter((_, i) => i % 2 === 0);
  } else {
    points = points.slice();
  }
  points.push({ t, mbps });

  return { ...series, points, stride, seen, lastSampleKey: sampleKey };
}

/** Total points currently held — the bound the tests assert against. */
export function totalPoints(state: SpeedSeriesState): number {
  return state.series.reduce((n, s) => n + s.points.length, 0);
}

/** The most recent reading of a series, or `null` if it has none. */
export function latest(series: Series): SeriesPoint | null {
  return series.points.length > 0 ? series.points[series.points.length - 1] : null;
}
