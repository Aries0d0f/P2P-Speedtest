import { useSpeedSeries } from "~/hooks/speed-series.hook";
import { BsArrows } from "react-icons/bs";
import {
  IoTabletPortraitOutline,
  IoPhonePortraitOutline,
  IoPhonePortraitSharp,
  IoLaptopOutline,
} from "react-icons/io5";
import { FaApple, FaWindows, FaAndroid, FaLinux, FaQuestion } from "react-icons/fa6";
import type {
  LiveTestPresentation,
  PeerView,
} from "~/model/presentation.model";

import { PeerGlobe } from "./PeerGlobe";
import { RealtimeSpeedGraph } from "./RealtimeSpeedGraph";
import { SpeedGauge } from "./SpeedGauge";
import type { GlobeSceneFactory } from "~/model/globe.model";
import { usePrefersReducedMotion } from "~/hooks/reduced-motion.hook";
import { UAParser } from "ua-parser-js";

/**
 * The live test dashboard (6.5).
 *
 * Composes the globe, graph and gauge, and owns the run-scoped series the last
 * two share — one monotonic ceiling means a needle position and a trace height
 * mean the same thing. It configures itself from the presentation rather than
 * taking a mode from the caller, which is what lets the same component serve
 * every point in the room's life and the stored-result page.
 *
 * The whole subtree is an *enhancement*: mounted beside — never around — the
 * core test panel, so nothing here can remove a metric, the badge, the status
 * or the Cancel button. It reads a snapshot and writes nothing back.
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
  const { series } = useSpeedSeries(presentation);

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
      <PeerGlobe
        presentation={presentation}
        createScene={createScene}
        onVisualError={onVisualError}
      />

      <PeerLocations presentation={presentation} />
      <StageAnnouncement presentation={presentation} />

      {(showGraph || showGauge) && (
        <div
          className={`grid w-full gap-4 ${showGraph && showGauge ? "md:grid-cols-[1.6fr_1fr]" : ""}`}
        >
          {showGraph && (
            <RealtimeSpeedGraph state={series} reducedMotion={reducedMotion} />
          )}
          {showGauge && (
            <SpeedGauge
              presentation={presentation}
              ceiling={series.ceiling}
              reducedMotion={reducedMotion}
            />
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
function PeerLocations({
  presentation,
}: {
  presentation: LiveTestPresentation;
}) {
  const { localPeer, remotePeer, channels } = presentation;
  return (
    <section
      aria-label="Peers and locations"
      className="surface-panel flex flex-col gap-1 rounded-xl border border-gray-200 px-4 py-3 dark:border-gray-700"
    >
      <div className="flex flex-row gap-1 place-content-between place-items-center">
        <PeerLine peer={localPeer} suffix=" (You)" />
        <BsArrows className="shrink-0 text-lg text-gray-600 dark:text-gray-300" />
        <PeerLine peer={remotePeer} suffix="" />
      </div>
      {channels.map((channel) => {
        const from =
          channel.senderSlot === localPeer.slot
            ? localPeer.name
            : remotePeer.name;
        const to =
          channel.receiverSlot === localPeer.slot
            ? localPeer.name
            : remotePeer.name;
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

function PeerLine({ peer, suffix }: { peer: PeerView; suffix: string }) {
  const locationStr = Array.from(
    new Set(
      [
        peer?.geo?.district,
        peer?.geo?.city,
        peer?.geo?.regionName,
        peer?.geo?.country,
      ].filter(Boolean),
    ),
  ).join(`, `);
  const { os, device } = UAParser(peer.ua);
  const DeviceIcon =
    device.type === "mobile"
      ? device.vendor === "Apple"
        ? IoPhonePortraitOutline
        : IoPhonePortraitSharp
      : device.type === "tablet" || peer.name.includes("Pad")
        ? IoTabletPortraitOutline
        : IoLaptopOutline;
  const BrandIcon = device.vendor === "Apple"
    ? FaApple
    : device.vendor === "Microsoft" || os.name?.includes("Windows")
      ? FaWindows
      : device.vendor === "Google" || os.name?.includes("Android")
        ? FaAndroid
        : device.vendor === "Linux"
          ? FaLinux
          : FaQuestion;
  return (
    <div className={`w-full flex flex-row nth-last-of-type-1:text-end nth-last-of-type-1:flex-row-reverse ${ device.type === "mobile" ? "gap-2" : "gap-3" }`}>
      <div className="flex place-content-center place-items-center">
        <DeviceIcon className="w-10 h-10 text-4xl inline h-4 w-4 text-gray-600 dark:text-gray-300" />
        <BrandIcon className="absolute inline h-4 w-4 text-gray-600 dark:text-gray-300" />
      </div>
      <p className="flex flex-col text-gray-600 dark:text-gray-300">
        <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {peer.name}
          {suffix}
        </span>
        <span className={peer.protocol === "IPv6" ? "text-xs" : "text-sm"}>
          {peer.ip}
        </span>
        {peer.location && locationStr ? (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {locationStr}
          </span>
        ) : (
          // Says exactly whose location is missing, and never guesses one.
          <span className="text-gray-500 dark:text-gray-400">
            {peer.profileKnown
              ? "location not shared"
              : "location not received yet"}
          </span>
        )}
      </p>
    </div>
  );
}

/**
 * Stage changes are announced politely. Speed updates are not: at four
 * updates a second, announcing them would make the page unusable with a
 * screen reader. The numbers stay readable on demand in the gauge and graph.
 */
function StageAnnouncement({
  presentation,
}: {
  presentation: LiveTestPresentation;
}) {
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
