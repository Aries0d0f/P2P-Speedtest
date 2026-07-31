import { useEffect, useRef } from "react";

import { useAnimatedScalar } from "~/hooks/animated-scalar.hook";
import { formatMbps } from "~/lib/format-speed";
import {
  CENTER,
  RADIUS,
  TRACK_PATH,
  angleFor,
  arcLengthFor,
  arcPath,
  fraction,
} from "~/lib/gauge-geometry";

import type { LiveTestPresentation, TransferChannel } from "~/model/presentation.model";


/**
 * The speed gauge (6.4). One labelled needle per directional stage, two for
 * duplex — never summed or averaged, and no field carrying a combined figure
 * exists anywhere in the data path. Shares the graph's monotonic ceiling, so a
 * needle position means the same thing in both widgets.
 */

export interface SpeedGaugeProps {
  presentation: LiveTestPresentation;
  /** Shared with `RealtimeSpeedGraph` so both widgets read the same scale. */
  ceiling: number;
  reducedMotion?: boolean;
}

export function SpeedGauge({ presentation, ceiling, reducedMotion = false }: SpeedGaugeProps) {
  const channels = presentation.channels;
  const duplex = presentation.mode === "duplex";

  return (
    <section
      aria-label="Live speed"
      className="surface-panel flex w-full flex-col items-center gap-2 rounded-2xl border border-gray-200 p-4 dark:border-gray-700"
    >
      <svg
        viewBox="0 0 128 112"
        role="img"
        aria-hidden="true"
        className="w-full max-w-[15rem]"
        data-testid="speed-gauge"
      >
        <path
          d={TRACK_PATH}
          fill="none"
          strokeWidth={9}
          strokeLinecap="round"
          className="stroke-gray-200 dark:stroke-gray-800"
        />
        {channels.map((channel, index) => (
          <GaugeChannel
            key={channel.key}
            channel={channel}
            ceiling={ceiling}
            reducedMotion={reducedMotion}
            /* The second duplex needle sits on an inner track so the two are
               distinguishable by position as well as label. */
            radius={RADIUS - index * 11}
            frozen={presentation.frozen}
          />
        ))}
        {/* Scale end-caps: the gauge is meaningless without knowing its range. */}
        <text x={12} y={104} textAnchor="middle" className="fill-gray-400 text-[8px]">
          0
        </text>
        <text x={116} y={104} textAnchor="middle" className="fill-gray-400 text-[8px]">
          {ceiling}
        </text>
      </svg>

      <ul className="flex w-full flex-col gap-1">
        {channels.length === 0 && (
          <li className="text-center text-xs text-gray-500 dark:text-gray-400">
            {presentation.active ? "Measuring latency…" : "No transfer in progress"}
          </li>
        )}
        {channels.map((channel) => (
          <li key={channel.key} className="flex items-baseline justify-between gap-3 text-sm">
            <span className="flex items-center gap-1.5 text-gray-600 dark:text-gray-300">
              <span
                aria-hidden="true"
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: `var(${channel.token})` }}
              />
              {/* Direction as text and as an arrow, so colour is never load-bearing. */}
              <span>{channel.label}</span>
              <span aria-hidden="true">{channel.role === "receive" ? "←" : "→"}</span>
            </span>
            <span className="font-mono tabular-nums text-gray-900 dark:text-gray-100">
              {channel.mbps === null ? (
                <span className="text-xs text-gray-500 dark:text-gray-400">measuring…</span>
              ) : (
                <>
                  <span data-testid={`gauge-value-${channel.key}`}>{formatMbps(channel.mbps)}</span>{" "}
                  <span className="text-xs text-gray-500 dark:text-gray-400">Mbps</span>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
      {duplex && (
        <p className="text-[11px] text-gray-500 dark:text-gray-400">
          Both directions run at once and are measured separately.
        </p>
      )}
    </section>
  );
}

function GaugeChannel({
  channel,
  ceiling,
  radius,
  reducedMotion,
  frozen,
}: {
  channel: TransferChannel;
  ceiling: number;
  radius: number;
  reducedMotion: boolean;
  frozen: boolean;
}) {
  const arcRef = useRef<SVGPathElement>(null);
  const needleRef = useRef<SVGLineElement>(null);

  const arcLength = arcLengthFor(radius);
  // Dash offset draws the arc; a rotation moves the needle. Both are written
  // straight to the element — no React state at 60 Hz.
  const { set } = useAnimatedScalar(
    (value) => {
      arcRef.current?.setAttribute("stroke-dashoffset", `${arcLength * (1 - value)}`);
      needleRef.current?.setAttribute(
        "transform",
        `rotate(${angleFor(value)} ${CENTER} ${CENTER})`,
      );
    },
    { duration: 260, ease: "outQuad" },
    [radius],
  );

  const value = channel.mbps === null ? 0 : fraction(channel.mbps, ceiling);
  useEffect(() => {
    // Reduced motion and the frozen finalizing state both write the final
    // value with no interpolation at all.
    set(value, reducedMotion || frozen);
  }, [set, value, reducedMotion, frozen]);

  const color = `var(${channel.token})`;
  return (
    <g data-testid={`gauge-channel-${channel.key}`} data-role={channel.role}>
      <path
        ref={arcRef}
        d={arcPath(0, 1, radius)}
        strokeDasharray={arcLength}
        fill="none"
        stroke={color}
        strokeWidth={7}
        strokeLinecap="round"
        // Solid for a receive channel, dashed for a send channel: the two
        // duplex arcs stay tellable apart with colour vision removed.
        opacity={channel.role === "receive" ? 0.95 : 0.7}
      />
      <line
        ref={needleRef}
        x1={CENTER}
        y1={CENTER}
        x2={CENTER}
        y2={CENTER - radius + 6}
        stroke={color}
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeDasharray={channel.role === "send" ? "4 3" : undefined}
        transform={`rotate(${angleFor(0)} ${CENTER} ${CENTER})`}
      />
    </g>
  );
}
