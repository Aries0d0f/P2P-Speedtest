import { ConnectionBadge } from "~/components/ConnectionBadge";
import { ShareActions } from "~/components/ShareActions";
import { bpsToMbps } from "~/lib/results-store";
import type { TerminalOutcome } from "~/model/room.model";

const RESULT_STATUS_COPY: Record<string, string> = {
  SUCCEED: "Test complete.",
  FAILED: "The test failed.",
  CANCELED: "The test was canceled.",
};

export function ResultSummary({
  outcome,
  onNewRoom,
}: {
  outcome: TerminalOutcome;
  onNewRoom: () => void;
}) {
  const data = outcome.record?.data;
  return (
    <>
      <p
        className={
          outcome.status === "FAILED"
            ? "text-red-600 dark:text-red-400"
            : "text-gray-700 dark:text-gray-200"
        }
      >
        {RESULT_STATUS_COPY[outcome.status] ?? outcome.status}
      </p>
      {data && <ConnectionBadge type={data.via} />}
      {data?.bandwidth.directional && data.bandwidth.directional.length > 0 && (
        <div className="flex flex-col items-center gap-1 text-sm text-gray-700 dark:text-gray-200">
          <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Directional
          </p>
          {data.bandwidth.directional.map((edge, i) => (
            <p key={i}>
              {bpsToMbps(edge.speed)} Mbps · {edge.latency.toFixed(0)} ms · loss{" "}
              {(edge.loss * 100).toFixed(2)}%
            </p>
          ))}
        </div>
      )}
      {data?.bandwidth.duplex && data.bandwidth.duplex.length > 0 && (
        <div className="flex flex-col items-center gap-1 text-sm text-gray-700 dark:text-gray-200">
          <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Duplex</p>
          {data.bandwidth.duplex.map((edge, i) => (
            <p key={i}>
              {bpsToMbps(edge.speed)} Mbps · {edge.latency.toFixed(0)} ms · loss{" "}
              {(edge.loss * 100).toFixed(2)}%
            </p>
          ))}
        </div>
      )}
      {outcome.record ? (
        <ShareActions result={outcome.record} />
      ) : (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          The result couldn't be saved on this device.
        </p>
      )}
      <button
        type="button"
        onClick={onNewRoom}
        className="rounded-full border border-gray-300 px-4 py-2 text-sm font-medium text-gray-900 dark:border-gray-600 dark:text-gray-100"
      >
        Start a new room
      </button>
    </>
  );
}
