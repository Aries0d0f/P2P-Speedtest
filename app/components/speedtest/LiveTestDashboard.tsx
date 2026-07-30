import { useEffect, useState } from "react";

import { emptySpeedSeries, recordSample, type SpeedSeriesState } from "~/lib/speed-series";
import type { LiveTestPresentation, VisualPeer } from "~/lib/test-visualization";

import { PeerGlobe } from "./PeerGlobe";
import { RealtimeSpeedGraph } from "./RealtimeSpeedGraph";
import { SpeedGauge } from "./SpeedGauge";
import type { GlobeSceneFactory } from "./three/globe-scene";
import { usePrefersReducedMotion } from "./use-reduced-motion";

/**
 * The live test dashboard (06-live-test-visualization 6.5).
 *
 * Composes the globe, graph and gauge, and owns the run-scoped speed series
 * that the last two share — one monotonic ceiling means a needle position and
 * a trace height mean the same thing.
 *
 * It configures itself from the presentation rather than taking a mode from
 * the caller, which is what lets the same component serve every point in the
 * room's life and the stored-result page too:
 *
 * | when | globe | graph | gauge |
 * |---|---|---|---|
 * | waiting / pairing / paired | yes | — | — |
 * | testing | yes | yes | yes |
 * | finalizing | yes | yes | frozen |
 * | result, and the stored-result page | yes | if there is history | — |
 *
 * This whole subtree is an *enhancement*. It is lazily imported and mounted
 * beside — never around — the room's core test panel, so nothing here can
 * remove a metric, the connection badge, the status, or the Cancel button.
 * It reads a presentation snapshot and writes nothing back.
 */

export interface LiveTestDashboardProps {
  presentation: LiveTestPresentation;
  /** Imperative failures from Three.js or Anime.js after mount; React error
   * boundaries cannot see those. */
  onVisualError?: (error: unknown) => void;
  /** Test/harness seam, forwarded to `PeerGlobe`. */
  createScene?: GlobeSceneFactory;
}

export default function LiveTestDashboard({
  presentation,
  onVisualError,
  createScene,
}: LiveTestDashboardProps) {
  const reducedMotion = usePrefersReducedMotion();
  const [series, setSeries] = useState<SpeedSeriesState>(emptySpeedSeries);

  // The series is fed from presentation snapshots only, at Phase 4's bounded
  // cadence. `recordSample` returns the identical object when a render carries
  // no new observation, so a duplicate render costs one comparison.
  useEffect(() => {
    const nowMs = typeof performance !== "undefined" ? performance.now() : 0;
    setSeries((previous) =>
      recordSample(previous, {
        runId: presentation.runId,
        nowMs,
        channels: presentation.channels,
      }),
    );
  }, [presentation]);

  // An empty graph before the first reading, or a live gauge on a finished
  // run, would be furniture rather than information.
  const showGraph = series.series.length > 0;
  const showGauge = presentation.channels.length > 0;

  return (
    <div
      data-live-dashboard=""
      data-testid="live-test-dashboard"
      className="flex w-full flex-col gap-4"
    >
      <PeerGlobe presentation={presentation} createScene={createScene} onVisualError={onVisualError} />

      <PeerLocations presentation={presentation} />
      <StageAnnouncement presentation={presentation} />

      {(showGraph || showGauge) && (
        <div className={`grid w-full gap-4 ${showGraph && showGauge ? "md:grid-cols-[1.6fr_1fr]" : ""}`}>
          {showGraph && <RealtimeSpeedGraph state={series} reducedMotion={reducedMotion} />}
          {showGauge && (
            <SpeedGauge presentation={presentation} ceiling={series.ceiling} reducedMotion={reducedMotion} />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The text equivalent of the markers and the route. Present whether or not
 * the canvas rendered, which is what lets the canvas be `aria-hidden`.
 */
function PeerLocations({ presentation }: { presentation: LiveTestPresentation }) {
  const { localPeer, remotePeer, channels } = presentation;
  return (
    <section
      aria-label="Peers and locations"
      className="surface-panel flex flex-col gap-1 rounded-2xl px-4 py-3 text-xs"
    >
      <PeerLine peer={localPeer} suffix=" (you)" />
      <PeerLine peer={remotePeer} suffix="" />
      {channels.map((channel) => {
        const from = channel.senderSlot === localPeer.slot ? localPeer.name : remotePeer.name;
        const to = channel.receiverSlot === localPeer.slot ? localPeer.name : remotePeer.name;
        return (
          <p key={channel.key} className="text-gray-600 dark:text-gray-300">
            {/* Direction spelled out, not only drawn. */}
            {from} → {to} ({channel.label.toLowerCase()})
          </p>
        );
      })}
    </section>
  );
}

function PeerLine({ peer, suffix }: { peer: VisualPeer; suffix: string }) {
  return (
    <p className="text-gray-600 dark:text-gray-300">
      <span className="font-medium text-gray-900 dark:text-gray-100">
        {peer.name}
        {suffix}
      </span>{" "}
      {peer.location ? (
        <span className="text-gray-500 dark:text-gray-400">
          {peer.location.lat.toFixed(2)}, {peer.location.lon.toFixed(2)}
        </span>
      ) : (
        // Says exactly whose location is missing, and never guesses one.
        <span className="text-gray-500 dark:text-gray-400">
          {peer.profileKnown ? "location not shared" : "location not received yet"}
        </span>
      )}
    </p>
  );
}

/**
 * Stage changes are announced politely. Speed updates are not: at four
 * updates a second, announcing them would make the page unusable with a
 * screen reader. The numbers stay readable on demand in the gauge and graph.
 */
function StageAnnouncement({ presentation }: { presentation: LiveTestPresentation }) {
  const message = presentation.stageName
    ? `Measuring ${presentation.stageName}`
    : presentation.active
      ? "Measuring latency"
      : "";

  return (
    <p aria-live="polite" className="sr-only" data-testid="stage-announcement">
      {message}
    </p>
  );
}
