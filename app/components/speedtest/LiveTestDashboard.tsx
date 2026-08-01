import { useSpeedSeries } from "~/hooks/speed-series.hook";
import {
  FaShieldHalved,
  FaServer,
  FaSignal,
  FaSpinner,
  FaArrowLeftLong,
  FaArrowRightLong,
  FaArrowRightArrowLeft,
} from "react-icons/fa6";
import { BsThreeDots, BsArrows } from "react-icons/bs";
import type {
  LiveTestPresentation,
  PeerView,
} from "~/model/presentation.model";

import { PeerGlobe } from "./PeerGlobe";
import { RealtimeSpeedGraph } from "./RealtimeSpeedGraph";
import { SpeedGauge } from "./SpeedGauge";
import type { GlobeSceneFactory } from "~/model/globe.model";
import { usePeerIcon } from "~/hooks/peer-icon.hook";
import { usePrefersReducedMotion } from "~/hooks/reduced-motion.hook";
import { ConnectionBadge } from "../ConnectionBadge";
import { useState } from "react";

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

      <PeerPresentation presentation={presentation} />
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
function PeerPresentation({
  presentation,
}: {
  presentation: LiveTestPresentation;
}) {
  const [showPeerDetails, setShowPeerDetails] = useState(false);
  const { localPeer, remotePeer, phase, stageName, connectionType } =
    presentation;
  const iconClassName =
    "shrink-0 text-lg text-gray-600 dark:text-gray-300 shrink-0 py-1 sm:py-0 h-8 sm:h-auto w-10 sm:w-auto rotate-90 sm:rotate-0";
  return (
    <section
      aria-label="Peers"
      className="reactive flex flex-col place-items-center"
    >
      <ConnectionBadge type={connectionType} variant="legend" />
      <div className="w-full surface-panel rounded-xl border border-gray-200 pt-6 sm:pt-4 px-4 py-3 dark:border-gray-700 flex flex-col gap-3 sm:gap-2">
        <div
          onClick={() => setShowPeerDetails((prev) => !prev)}
          className="flex sm:flex-row flex-col gap-2 sm:gap-4 sm:place-content-between place-content-start sm:place-items-center"
        >
          <PeerLine peer={localPeer} suffix=" (You)" type="local" />
          {["waiting", "pairing", "finalizing"].includes(phase) ? (
            <>
              <BsThreeDots className={iconClassName} />
              <PeerLinePlaceholder />
            </>
          ) : (
            <>
              {phase === "testing" ? (
                stageName === "duplex" ? (
                  <FaArrowRightArrowLeft className={iconClassName} />
                ) : stageName === "download" ? (
                  <FaArrowLeftLong className={iconClassName} />
                ) : stageName === "upload" ? (
                  <FaArrowRightLong className={iconClassName} />
                ) : null
              ) : (
                <BsArrows className={iconClassName} />
              )}
              <PeerLine peer={remotePeer} suffix="" type="remote" />
            </>
          )}
        </div>
        {showPeerDetails && (
          <PeerDetails localPeer={localPeer} remotePeer={remotePeer} />
        )}
      </div>
    </section>
  );
}

function PeerLine({
  peer,
  suffix,
  type,
}: {
  peer: PeerView;
  suffix: string;
  type: "local" | "remote";
}) {
  const [showPeerDetails, setShowPeerDetails] = useState(false);

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
  const { DeviceIcon, BrandIcon, label } = usePeerIcon(peer);
  return (
    <>
      <aside
        onClick={() => setShowPeerDetails((prev) => !prev)}
        className={`w-full flex flex-row sm:nth-last-of-type-1:text-end sm:nth-last-of-type-1:flex-row-reverse sm:nth-last-of-type-1:[&>div>h3]:flex-row-reverse ${peer.icon?.type === "mobile" ? "gap-2" : "gap-3"}`}
      >
        <div
          className="flex place-content-center place-items-center"
          {...(label
            ? { role: "img", "aria-label": label }
            : { "aria-hidden": true })}
        >
          <DeviceIcon
            aria-hidden="true"
            className="w-10 h-10 text-4xl inline h-4 w-4 text-gray-600 dark:text-gray-300"
          />
          <BrandIcon
            aria-hidden="true"
            className="absolute inline h-4 w-4 text-gray-600 dark:text-gray-300"
          />
        </div>
        <div className="flex flex-col gap-0.25 place-content-center">
          <h3 className="flex flex-row place-items-center gap-1">
            <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {peer.name}
              {suffix}
            </span>
            <span className="text-xs">
              {peer.geo?.proxy && <FaShieldHalved />}
              {peer.geo?.hosting && <FaServer />}
              {peer.geo?.mobile && <FaSignal />}
            </span>
          </h3>
          <p className="flex flex-col text-gray-600 dark:text-gray-300">
            <span
              className={
                peer.protocol === "IPv6" ? "text-xs/4.25" : "text-sm/4"
              }
            >
              {peer.ip || "-"}
            </span>
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {peer.location && locationStr
                ? locationStr
                : // Says exactly whose location is missing, and never guesses one.
                  peer.profileKnown
                  ? "location not shared"
                  : "location not received yet"}
            </span>
          </p>
        </div>
      </aside>
      {type === "local" && showPeerDetails && (
        <PeerDetails localPeer={peer} variant="compact-local" />
      )}
      {type === "remote" && showPeerDetails && (
        <PeerDetails remotePeer={peer} variant="compact-remote" />
      )}
    </>
  );
}

function PeerLinePlaceholder() {
  return (
    <aside
      className={`w-full flex flex-row nth-last-of-type-1:text-end nth-last-of-type-1:flex-row-reverse nth-last-of-type-1:[&>div>h3]:flex-row-reverse`}
    >
      {/* The one thing on this line that would otherwise exist only in
          pixels, so the pair is announced as a single named image. */}
      <div
        className="flex place-content-center place-items-center"
        role="img"
        aria-label="Unknown peer"
        aria-hidden="true"
      >
        <FaSpinner className="animate-spin-step w-10 h-10 p-2 text-4xl inline h-4 w-4 text-gray-600 dark:text-gray-300" />
      </div>
      <div className="flex flex-col gap-0.25 place-content-center">
        <h3 className="flex flex-row place-items-center gap-1">
          <i className="text-sm font-medium text-gray-600 dark:text-gray-400">
            Waiting for peer...
          </i>
        </h3>
      </div>
    </aside>
  );
}

function PeerDetails({
  localPeer,
  remotePeer,
  variant = "full",
}:
  | {
      localPeer: PeerView;
      remotePeer: PeerView;
      variant?: "full";
    }
  | {
      localPeer: PeerView;
      remotePeer?: PeerView;
      variant: "compact-local";
    }
  | {
      localPeer?: PeerView;
      remotePeer: PeerView;
      variant: "compact-remote";
    }) {
  const [showPeerDetails, setShowPeerDetails] = useState(false);
  const networkTypeAnnotations = [
    {
      name: "Proxy/VPN",
      icon: <FaShieldHalved />,
      present: (peer: PeerView) => peer.geo?.proxy,
    },
    {
      name: "Hosting",
      icon: <FaServer />,
      present: (peer: PeerView) => peer.geo?.hosting,
    },
    {
      name: "Cellular",
      icon: <FaSignal />,
      present: (peer: PeerView) => peer.geo?.mobile,
    },
  ];
  const showNetworkTypeAnnotations = networkTypeAnnotations.filter(
    (a) =>
      (localPeer && a.present(localPeer)) ||
      (remotePeer && a.present(remotePeer)),
  );
  const dataFields = [
    {
      label: "ISP",
      data: (peer: PeerView) =>
        peer.geo && [peer.geo.isp, peer.geo.org].filter(Boolean).join(" · "),
      className: "text-tiny",
    },
    {
      label: "User Agent",
      data: (peer: PeerView) => peer.ua,
      className: "text-tiny",
    },
  ];

  return (
    <>
      <hr
        className={`${variant === "full" ? "hidden sm:block" : "sm:hidden block"} border-t border-t-gray-200 dark:border-t-gray-700`}
      />
      <div
        className={`${variant === "full" ? "hidden sm:flex" : "sm:hidden flex"} flex-col gap-1.5 pt-1`}
      >
        {showNetworkTypeAnnotations.length > 0 && (
          <div className="flex flex-row gap-3 place-content-between text-xs text-gray-500 dark:text-gray-400">
            <label className="min-w-[6rem] sm:text-center sm:hidden font-medium whitespace-nowrap">
              Network Type
            </label>
            {localPeer && (
              <p className="flex flex-row gap-1 w-full empty:before:content-['-'] place-content-end sm:place-content-start">
                {networkTypeAnnotations
                  .filter((a) => a.present(localPeer))
                  .map((a, index, { length }) => (
                    <>
                      <span
                        key={a.name}
                        className="flex flex-row gap-1 place-items-center"
                      >
                        {a.icon}
                        {a.name}
                      </span>
                      {index < length - 1 && (
                        <span className="text-gray-400 dark:text-gray-600">
                          ·
                        </span>
                      )}
                    </>
                  ))}
              </p>
            )}
            <label className="min-w-[6rem] sm:text-center hidden sm:block font-medium whitespace-nowrap">
              Network Type
            </label>
            {remotePeer && (
              <p className="flex flex-row gap-1 w-full empty:before:content-['-'] place-content-end">
                {networkTypeAnnotations
                  .filter((a) => a.present(remotePeer))
                  .map((a, index, { length }) => (
                    <>
                      <span
                        key={a.name}
                        className="flex flex-row gap-1 place-items-center"
                      >
                        {a.icon}
                        {a.name}
                      </span>
                      {index < length - 1 && (
                        <span className="text-gray-400 dark:text-gray-600">
                          ·
                        </span>
                      )}
                    </>
                  ))}
              </p>
            )}
          </div>
        )}
        {dataFields.map(({ label, data, className }) => (
          <div className="flex flex-row gap-3 place-content-between text-xs text-gray-500 dark:text-gray-400">
            <label className="min-w-[6rem] sm:text-center sm:hidden font-medium whitespace-nowrap">{label}</label>
            {localPeer && (
              <p className={`w-full text-right sm:text-left ${className}`}>{data(localPeer) || "-"}</p>
            )}
            <label className="min-w-[6rem] sm:text-center hidden sm:block font-medium whitespace-nowrap">{label}</label>
            {remotePeer && (
              <p className={`w-full text-right ${className}`}>
                {data(remotePeer) || "-"}
              </p>
            )}
          </div>
        ))}
      </div>
    </>
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
