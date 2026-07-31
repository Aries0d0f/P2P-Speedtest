import { Suspense, lazy } from "react";

import { ConnectionBadge } from "~/components/ConnectionBadge";
import { ShareActions } from "~/components/ShareActions";
import {
  LiveVisualizationBoundary,
  VisualizationPending,
} from "~/components/speedtest/LiveVisualizationBoundary";
import { bpsToMbps } from "~/lib/results-store";
import { selectStoredResultPresentation } from "~/lib/presentation-selector";
import type { GeoInfo } from "~/model/geo.model";
import type {
  BandwidthEdge,
  P2PSpeedtestResult,
  ResultPeer,
} from "~/model/result.model";

/**
 * The same globe the run itself showed, rebuilt from the stored record. Lazy
 * for the same reason as in the room: a visitor reading a text result never
 * downloads Three.js until this page decides to draw one.
 */
const LiveTestDashboard = lazy(() => import("~/components/speedtest/LiveTestDashboard"));

function GeoBlock({ geo }: { geo: GeoInfo }) {
  const place = [geo.city, geo.regionName, geo.country].filter(Boolean).join(", ");
  const flags = [geo.proxy ? "proxy/VPN" : null, geo.hosting ? "hosting network" : null].filter(
    (v): v is string => v !== null,
  );
  const network = [geo.isp, geo.org].filter(Boolean).join(" · ");
  // A geo holding only proxy/hosting (anonymous level) is normal, not
  // partial: the location block simply has nothing to show, and the flags
  // alone are real context for an unusual number.
  return (
    <div className="flex flex-col gap-0.5 text-xs text-gray-500 dark:text-gray-400">
      {place && <p>{place}</p>}
      {flags.length > 0 && <p>{flags.join(", ")}</p>}
      {network && <p>{network}</p>}
    </div>
  );
}

function PeerBlock({ peer }: { peer: ResultPeer }) {
  return (
    <div className="surface-panel flex flex-col gap-1 rounded-xl border border-gray-200 p-4 dark:border-gray-700">
      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{peer.name}</p>
      {/* A withheld field renders as no row at all (S3) — never "unknown" or
          a blank — and a masked IP is shown verbatim, its shape already
          saying it's masked. */}
      {peer.ip && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {peer.ip}
          {peer.protocol ? ` (${peer.protocol})` : ""}
        </p>
      )}
      {peer.ua && <p className="text-xs text-gray-500 dark:text-gray-400">{peer.ua}</p>}
      {peer.geo && <GeoBlock geo={peer.geo} />}
    </div>
  );
}

function EdgeRow({ edge, nameFor }: { edge: BandwidthEdge; nameFor: (id: string) => string }) {
  return (
    <p className="text-sm text-gray-700 dark:text-gray-200">
      {nameFor(edge.from)} → {nameFor(edge.to)}: {bpsToMbps(edge.speed)} Mbps · {edge.latency.toFixed(1)} ms
      latency · {edge.jitter.toFixed(1)} ms jitter · {(edge.loss * 100).toFixed(2)}% loss
    </p>
  );
}

function GroupBlock({
  label,
  edges,
  nameFor,
}: {
  label: string;
  edges: BandwidthEdge[] | undefined;
  nameFor: (id: string) => string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}</p>
      {edges && edges.length > 0 ? (
        edges.map((edge, i) => <EdgeRow key={i} edge={edge} nameFor={nameFor} />)
      ) : (
        <p className="text-xs text-gray-500 dark:text-gray-400">Not measured</p>
      )}
    </div>
  );
}

export function ResultDetailBody({ result }: { result: P2PSpeedtestResult }) {
  const { data, metadata } = result;
  const nameFor = (id: string) => data.peers.find((p) => p.id === id)?.name ?? id;
  return (
        <div className="flex w-full max-w-2xl flex-col gap-6">
          <section className="flex flex-col items-center gap-2 rounded-2xl border border-gray-200 p-5 text-center dark:border-gray-700">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {new Date(data.timestamp).toLocaleString()}
            </p>
            <p className="text-base font-medium text-gray-900 dark:text-gray-100">{data.status}</p>
            <ConnectionBadge type={data.via} />
          </section>

          {/* Only worth drawing when at least one peer shared a
              location; two peers who both withheld theirs would get an
              empty globe and a pair of "not shared" lines they can
              already read below. */}
          {data.peers.some((peer) => peer.geo?.lat !== undefined) && (
            <LiveVisualizationBoundary resetKey={`${metadata.id}:${metadata["peer-id"]}`}>
              <Suspense fallback={<VisualizationPending />}>
                <LiveTestDashboard
                  presentation={selectStoredResultPresentation({
                    runId: `${metadata.id}:${metadata["peer-id"]}`,
                    peers: [data.peers[0], data.peers[1]],
                    localPeerId: metadata["peer-id"],
                    connectionType: data.via,
                  })}
                />
              </Suspense>
            </LiveVisualizationBoundary>
          )}

          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium text-gray-700 dark:text-gray-200">Peers</h2>
            <div className="flex flex-col gap-3">
              {data.peers.map((peer) => (
                <PeerBlock key={peer.id} peer={peer} />
              ))}
            </div>
          </section>

          <section className="surface-panel flex flex-col gap-1 rounded-xl border border-gray-200 p-4 dark:border-gray-700">
            <h2 className="text-sm font-medium text-gray-700 dark:text-gray-200">Bandwidth</h2>
            <GroupBlock label="Directional" edges={data.bandwidth.directional} nameFor={nameFor} />
            <GroupBlock label="Duplex" edges={data.bandwidth.duplex} nameFor={nameFor} />
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-medium text-gray-700 dark:text-gray-200">Share</h2>
            <ShareActions result={result} />
          </section>

          <section className="flex flex-col gap-1 rounded-2xl border border-gray-200 p-5 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
            <p>Room: {metadata.id}</p>
            <p>Peer ID: {metadata["peer-id"]}</p>
            <p className="break-all">Checksum: {metadata.hash}</p>
          </section>
        </div>
  );
}
