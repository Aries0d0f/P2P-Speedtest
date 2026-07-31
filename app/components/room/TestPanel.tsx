import { ConnectionBadge } from "~/components/ConnectionBadge";
import { bpsToMbps } from "~/lib/results-store";
import type { RoomState } from "~/model/room.model";
import { stageName } from "~/model/stage.model";

import { OtherPeerSummary } from "./PeerSummary";

function formatMbps(bytes: number, elapsedMs: number): string {
  if (elapsedMs <= 0) return "0.0";
  return bpsToMbps((bytes * 8) / (elapsedMs / 1000));
}

export function TestPanel({ state, onCancel }: { state: RoomState; onCancel: () => void }) {
  const {
    phase,
    self,
    other,
    otherProfile,
    connectionType,
    stageId,
    stageProgress,
    liveLatency,
    latencyBaseline,
  } = state;

  return (
    <>
      {connectionType !== "UNKNOWN" ||
      phase === "paired" ||
      phase === "testing" ||
      phase === "finalizing" ? (
        <ConnectionBadge type={connectionType} />
      ) : null}
      <p className="text-gray-700 dark:text-gray-200">
        {phase === "waiting" && (other ? "Peer joined!" : "Waiting for a peer…")}
        {phase === "pairing" && "Connecting to peer…"}
        {phase === "paired" && "Paired!"}
        {phase === "testing" &&
          (stageId === null ? "Measuring latency…" : `Measuring ${stageName(stageId)}…`)}
        {phase === "finalizing" && "Finalizing…"}
      </p>
      {self && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          You are slot {self.slot}
          {other ? `, peer is slot ${other.slot}` : ""}
        </p>
      )}
      {otherProfile ? (
        <OtherPeerSummary profile={otherProfile} />
      ) : (
        phase !== "waiting" && (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Waiting for the other peer to introduce themselves…
          </p>
        )
      )}
      {phase === "testing" && (
        <div className="flex flex-col items-center gap-1">
          {latencyBaseline === undefined ? (
            liveLatency ? (
              <p className="text-sm text-gray-700 dark:text-gray-200">
                RTT {liveLatency.rttMs.toFixed(0)} ms
                {liveLatency.jitterMs !== null &&
                  ` · jitter ${liveLatency.jitterMs.toFixed(1)} ms`}
              </p>
            ) : (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Measuring…
              </p>
            )
          ) : latencyBaseline === null ? (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Couldn't measure latency.
            </p>
          ) : (
            <p className="text-sm text-gray-700 dark:text-gray-200">
              RTT {latencyBaseline.rttMs.toFixed(0)} ms · jitter{" "}
              {latencyBaseline.jitterMs.toFixed(1)} ms
            </p>
          )}
        </div>
      )}
      {phase === "testing" && stageId !== null && self && (
        <div className="flex flex-col items-center gap-1">
          {Object.entries(stageProgress.entries)
            .filter(([key]) => key.startsWith(`${stageId}:`))
            .map(([key, snap]) => (
              <p key={key} className="text-sm text-gray-700 dark:text-gray-200">
                {snap.receiverSlot === self.slot ? "You" : "Peer"} receiving:{" "}
                {formatMbps(snap.bytes, snap.elapsedMs)} Mbps
                {snap.highestSeqPlusOne > 0 &&
                  ` · loss ${(
                    (1 - snap.chunksSeen / snap.highestSeqPlusOne) *
                    100
                  ).toFixed(1)}%`}
              </p>
            ))}
        </div>
      )}
      {(phase === "testing" || phase === "finalizing") && (
        <button
          type="button"
          disabled={phase === "finalizing"}
          onClick={onCancel}
          className="rounded-full border border-gray-300 px-4 py-2 text-sm font-medium text-gray-900 disabled:opacity-50 dark:border-gray-600 dark:text-gray-100"
        >
          Cancel
        </button>
      )}
    </>
  );
}
