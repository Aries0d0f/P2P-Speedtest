import { useEffect, useRef } from "react";

import { stageName, type StageId } from "~/lib/stage";
import { latest, type Series, type SpeedSeriesState } from "~/lib/speed-series";

import { createAnimatedScalar, type AnimatedScalar } from "./anime-scalar";

/**
 * The live speed graph (06-live-test-visualization 6.4).
 *
 * Each `(stage, edge)` is its own polyline, so there is never a misleading
 * diagonal joining the end of one stage to the start of the next, and the two
 * duplex directions are two traces rather than one combined line.
 *
 * The x-axis is **time within a stage**, not time within the run: every trace
 * starts at zero and they overlay. Laying the stages out end to end instead
 * spent most of the plot on the gaps between them and made the one comparison
 * a viewer actually wants — how the three stages ramp against each other —
 * impossible to make by eye.
 *
 * The polylines come straight from `speed-series.ts`'s bounded buffers and are
 * re-rendered by React at Phase 4's sample rate — no path morphing, so point
 * topology never changes unpredictably. Anime.js drives only the two things
 * that genuinely change between samples: each series' live numeric readout,
 * and a one-off draw-in when a stage's trace first appears.
 */

const VIEW_WIDTH = 320;
const VIEW_HEIGHT = 132;
const PLOT_LEFT = 34;
const PLOT_RIGHT = VIEW_WIDTH - 6;
const PLOT_TOP = 10;
const PLOT_BOTTOM = VIEW_HEIGHT - 20;
const PLOT_WIDTH = PLOT_RIGHT - PLOT_LEFT;
const PLOT_HEIGHT = PLOT_BOTTOM - PLOT_TOP;

/** Keeps a trace that lands exactly on the ceiling inside the plot area
 * (`niceCeiling` deliberately adds no headroom of its own). */
const TOP_MARGIN = 0.06;

/** Minimum x-extent so a stage's first seconds do not stretch across the
 * whole plot and then visibly compress. */
const MIN_SPAN_MS = 10_000;

function spanSeconds(spanMs: number): number {
  return Math.max(MIN_SPAN_MS, spanMs) / 1000;
}

function xFor(t: number, spanMs: number): number {
  const span = Math.max(MIN_SPAN_MS, spanMs);
  return PLOT_LEFT + (t / span) * PLOT_WIDTH;
}

function yFor(mbps: number, ceiling: number): number {
  const fraction = ceiling > 0 ? Math.min(1, Math.max(0, mbps / ceiling)) : 0;
  return PLOT_BOTTOM - fraction * PLOT_HEIGHT * (1 - TOP_MARGIN);
}

function pointsFor(series: Series, ceiling: number, spanMs: number): string {
  return series.points
    .map((p) => `${xFor(p.t, spanMs).toFixed(1)},${yFor(p.mbps, ceiling).toFixed(1)}`)
    .join(" ");
}

function formatMbps(mbps: number): string {
  if (mbps >= 100) return mbps.toFixed(0);
  if (mbps >= 10) return mbps.toFixed(1);
  return mbps.toFixed(2);
}

function axisLabel(value: number): string {
  if (value >= 1000) return `${value / 1000}k`;
  return `${value}`;
}

export interface RealtimeSpeedGraphProps {
  state: SpeedSeriesState;
  reducedMotion?: boolean;
}

export function RealtimeSpeedGraph({ state, reducedMotion = false }: RealtimeSpeedGraphProps) {
  const { ceiling, spanMs, series } = state;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * ceiling);

  return (
    <section
      aria-label="Speed over time"
      className="surface-panel flex w-full flex-col gap-2 rounded-2xl border border-gray-200 p-4 dark:border-gray-700"
    >
      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        role="img"
        aria-hidden="true"
        className="w-full"
        data-testid="speed-graph"
      >
        {ticks.map((value) => (
          <g key={value}>
            <line
              x1={PLOT_LEFT}
              x2={PLOT_RIGHT}
              y1={yFor(value, ceiling)}
              y2={yFor(value, ceiling)}
              className="stroke-gray-200 dark:stroke-gray-800"
              strokeWidth={0.6}
            />
            <text
              x={PLOT_LEFT - 4}
              y={yFor(value, ceiling) + 2.5}
              textAnchor="end"
              className="fill-gray-400 text-[7px]"
            >
              {axisLabel(value)}
            </text>
          </g>
        ))}
        <text x={4} y={PLOT_TOP - 3} className="fill-gray-400 text-[7px]">
          Mbps
        </text>

        {/* Every stage shares this axis from its own zero, so the label has
            to say "into the stage" or the overlay reads as one timeline. */}
        <text x={PLOT_LEFT} y={PLOT_BOTTOM + 10} className="fill-gray-400 text-[7px]">
          0s
        </text>
        <text
          x={(PLOT_LEFT + PLOT_RIGHT) / 2}
          y={PLOT_BOTTOM + 10}
          textAnchor="middle"
          className="fill-gray-400 text-[7px]"
        >
          seconds into each stage
        </text>
        <text x={PLOT_RIGHT} y={PLOT_BOTTOM + 10} textAnchor="end" className="fill-gray-400 text-[7px]">
          {spanSeconds(spanMs).toFixed(0)}s
        </text>

        {series.map((s) => (
          <GraphSeries key={s.key} series={s} ceiling={ceiling} spanMs={spanMs} reducedMotion={reducedMotion} />
        ))}

        {series.length === 0 && (
          <text x={VIEW_WIDTH / 2} y={VIEW_HEIGHT / 2} textAnchor="middle" className="fill-gray-400 text-[8px]">
            waiting for the first reading
          </text>
        )}
      </svg>

      <ul className="flex flex-col gap-1">
        {series.map((s) => (
          <SeriesReadout key={s.key} series={s} reducedMotion={reducedMotion} />
        ))}
      </ul>
    </section>
  );
}

function GraphSeries({
  series,
  ceiling,
  spanMs,
  reducedMotion,
}: {
  series: Series;
  ceiling: number;
  spanMs: number;
  reducedMotion: boolean;
}) {
  const ref = useRef<SVGPolylineElement>(null);

  // A one-off draw-in the first time a stage's trace appears. Guarded because
  // `createDrawable` needs `getTotalLength`, which jsdom does not implement
  // and which a hostile SVG state could make throw; a missing flourish must
  // never take the graph down.
  useEffect(() => {
    if (reducedMotion) return;
    const element = ref.current;
    if (!element) return;
    let cancelled = false;
    let animation: { revert: () => void } | null = null;

    void (async () => {
      try {
        const [{ createDrawable }, { animate }] = await Promise.all([
          import("animejs/svg"),
          import("animejs/animation"),
        ]);
        if (cancelled || !ref.current) return;
        const drawables = createDrawable(ref.current);
        animation = animate(drawables, { draw: "0 1", duration: 420, ease: "outQuad" });
      } catch (error) {
        console.debug("graph draw-in skipped", error);
      }
    })();

    return () => {
      cancelled = true;
      animation?.revert();
    };
    // Deliberately once per series: re-running on every sample would restart
    // the draw-in four times a second.
  }, [reducedMotion]);

  return (
    <polyline
      ref={ref}
      data-testid={`series-${series.key}`}
      data-role={series.role}
      points={pointsFor(series, ceiling, spanMs)}
      fill="none"
      stroke={`var(${series.token})`}
      strokeWidth={1.6}
      strokeLinejoin="round"
      strokeLinecap="round"
      // Solid receive, dashed send: the two duplex traces stay distinguishable
      // with colour vision removed.
      strokeDasharray={series.role === "send" ? "4 2.5" : undefined}
    />
  );
}

function SeriesReadout({ series, reducedMotion }: { series: Series; reducedMotion: boolean }) {
  const valueRef = useRef<HTMLSpanElement>(null);
  const scalarRef = useRef<AnimatedScalar | null>(null);

  useEffect(() => {
    const element = valueRef.current;
    if (!element) return;
    const scalar = createAnimatedScalar((value) => {
      element.textContent = formatMbps(value);
    });
    scalarRef.current = scalar;
    return () => {
      scalar.dispose();
      scalarRef.current = null;
    };
  }, []);

  const current = latest(series);
  const value = current?.mbps ?? 0;
  useEffect(() => {
    scalarRef.current?.set(value, reducedMotion);
  }, [value, reducedMotion]);

  return (
    <li className="flex items-baseline justify-between gap-3 text-xs">
      <span className="flex items-center gap-1.5 text-gray-600 dark:text-gray-300">
        <svg aria-hidden="true" viewBox="0 0 16 6" className="h-1.5 w-4">
          <line
            x1={0}
            y1={3}
            x2={16}
            y2={3}
            stroke={`var(${series.token})`}
            strokeWidth={2}
            strokeDasharray={series.role === "send" ? "4 2.5" : undefined}
          />
        </svg>
        <span>
          {stageNameFor(series.stageId)} · {series.label}
        </span>
      </span>
      <span className="font-mono tabular-nums text-gray-700 dark:text-gray-200">
        <span ref={valueRef} data-testid={`readout-${series.key}`}>
          {formatMbps(value)}
        </span>{" "}
        <span className="text-gray-500 dark:text-gray-400">Mbps</span>
      </span>
    </li>
  );
}

function stageNameFor(stageId: StageId): string {
  const name = stageName(stageId);
  return name.charAt(0).toUpperCase() + name.slice(1);
}
