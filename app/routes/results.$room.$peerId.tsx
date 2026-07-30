import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ConnectionBadge } from "~/components/ConnectionBadge";
import { ShareActions } from "~/components/ShareActions";
import type { GeoInfo } from "~/lib/geo";
import {
  bpsToMbps,
  getResult,
  type BandwidthEdge,
  type P2PSpeedtestResult,
  type ResultPeer,
} from "~/lib/results";

import type { Route } from "./+types/results.$room.$peerId";

export function meta({}: Route.MetaArgs) {
  return [{ title: "P2P Speedtest — Result" }];
}

// Client-only storage (5.1) — see results.tsx for why "loading" is the
// stable SSR/first-paint state.
type LoadState =
  | { status: "loading" }
  | { status: "ok"; result: P2PSpeedtestResult }
  | { status: "not-found" }
  | { status: "invalid"; errors: string[] }
  | { status: "error"; reason: string };

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
    <div className="flex flex-col gap-1 rounded-xl border border-gray-200 p-4 dark:border-gray-700">
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

export default function ResultDetail({ params }: Route.ComponentProps) {
  const { room, peerId } = params;
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    void getResult(room, peerId).then((outcome) => {
      if (cancelled) return;
      setState(outcome);
    });
    return () => {
      cancelled = true;
    };
  }, [room, peerId]);

  return (
    <main className="flex min-h-screen flex-col items-center gap-6 px-4 py-16">
      <Link to="/results" className="text-sm text-gray-500 underline dark:text-gray-400">
        ← All results
      </Link>

      {state.status === "loading" && (
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
      )}

      {state.status === "not-found" && (
        <p className="text-sm text-gray-700 dark:text-gray-200">
          No result for this room and peer on this device.
        </p>
      )}

      {state.status === "invalid" && (
        <div className="flex w-full max-w-lg flex-col gap-1 text-sm text-red-600 dark:text-red-400">
          <p>This stored record is malformed and can't be displayed.</p>
          {state.errors.map((e, i) => (
            <p key={i} className="text-xs">
              {e}
            </p>
          ))}
        </div>
      )}

      {state.status === "error" && (
        <p className="text-sm text-red-600 dark:text-red-400">
          Couldn't read this result ({state.reason}).
        </p>
      )}

      {state.status === "ok" &&
        (() => {
          const { data, metadata } = state.result;
          const nameFor = (id: string) => data.peers.find((p) => p.id === id)?.name ?? id;
          return (
            <div className="flex w-full max-w-lg flex-col gap-6">
              <section className="flex flex-col items-center gap-2 rounded-2xl border border-gray-200 p-5 text-center dark:border-gray-700">
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {new Date(data.timestamp).toLocaleString()}
                </p>
                <p className="text-base font-medium text-gray-900 dark:text-gray-100">{data.status}</p>
                <ConnectionBadge type={data.via} />
              </section>

              <section className="flex flex-col gap-3">
                <h2 className="text-sm font-medium text-gray-700 dark:text-gray-200">Peers</h2>
                <div className="flex flex-col gap-3">
                  {data.peers.map((peer) => (
                    <PeerBlock key={peer.id} peer={peer} />
                  ))}
                </div>
              </section>

              <section className="flex flex-col gap-3 rounded-2xl border border-gray-200 p-5 dark:border-gray-700">
                <h2 className="text-sm font-medium text-gray-700 dark:text-gray-200">Bandwidth</h2>
                <GroupBlock label="Directional" edges={data.bandwidth.directional} nameFor={nameFor} />
                <GroupBlock label="Duplex" edges={data.bandwidth.duplex} nameFor={nameFor} />
              </section>

              <section className="flex flex-col gap-2">
                <h2 className="text-sm font-medium text-gray-700 dark:text-gray-200">Share</h2>
                <ShareActions result={state.result} />
              </section>

              <section className="flex flex-col gap-1 rounded-2xl border border-gray-200 p-5 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
                <p>Room: {metadata.id}</p>
                <p>Peer ID: {metadata["peer-id"]}</p>
                <p className="break-all">Checksum: {metadata.hash}</p>
              </section>
            </div>
          );
        })()}
    </main>
  );
}
