import { useEffect, useRef } from "react";

import { useAnimatedScalar } from "~/hooks/animated-scalar.hook";
import { useSvgDrawIn } from "~/hooks/svg-draw-in.hook";
import { formatMbps } from "~/lib/format-speed";
import {
  PLOT_BOTTOM,
  PLOT_LEFT,
  PLOT_RIGHT,
  PLOT_TOP,
  VIEW_HEIGHT,
  VIEW_WIDTH,
  axisLabel,
  pointsFor,
  spanSeconds,
  yFor,
} from "~/lib/graph-geometry";

import { stageName, type StageId } from "~/model/stage.model";
import { latest } from "~/lib/speed-series";
import type { Series, SpeedSeriesState } from "~/model/speed-series.model";


/**
 * The live speed graph (6.4).
 *
 * Each `(stage, edge)` is its own polyline, so no misleading diagonal joins
 * the end of one stage to the start of the next. The x-axis is time *within a
 * stage*, not within the run: every trace starts at zero and they overlay,
 * which is the one comparison a viewer actually wants.
 *
 * Points come straight from the bounded buffers and are re-rendered by React
 * — no path morphing, so point topology never changes unpredictably. Anime.js
 * drives only the live readout and a one-off draw-in per trace.
 */

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
  useSvgDrawIn(ref, !reducedMotion);

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
  const { set } = useAnimatedScalar((value) => {
    if (valueRef.current) valueRef.current.textContent = formatMbps(value);
  });

  const current = latest(series);
  const value = current?.mbps ?? 0;
  useEffect(() => {
    set(value, reducedMotion);
  }, [set, value, reducedMotion]);

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
