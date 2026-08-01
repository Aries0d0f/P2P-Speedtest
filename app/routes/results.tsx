import { Link } from "react-router";
import { ConnectionBadge } from "~/components/ConnectionBadge";
import { useResultHistory } from "~/hooks/result-history.hook";
import { bpsToMbps } from "~/lib/results-store";
import type {
  BandwidthEdge,
  P2PSpeedtestResult,
  ResultStatus,
} from "~/model/result.model";

import type { Route } from "./+types/results";

export function meta({}: Route.MetaArgs) {
  return [{ title: "P2P Speedtest — Results" }];
}

const STATUS_COPY: Record<ResultStatus, { label: string; className: string }> = {
  SUCCEED: {
    label: "Succeeded",
    className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  },
  FAILED: {
    label: "Failed",
    className: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  },
  CANCELED: {
    label: "Canceled",
    className: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  },
};

function StatusBadge({ status }: { status: ResultStatus }) {
  const copy = STATUS_COPY[status];
  return (
    <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${copy.className}`}>
      {copy.label}
    </span>
  );
}

function EdgeLine({ edge }: { edge: BandwidthEdge }) {
  return (
    <p>
      {bpsToMbps(edge.speed)} Mbps · {edge.latency.toFixed(0)} ms · loss {(edge.loss * 100).toFixed(2)}%
    </p>
  );
}

function ResultRow({
  result,
  selected,
  onToggle,
}: {
  result: P2PSpeedtestResult;
  selected: boolean;
  onToggle: () => void;
}) {
  const { data, metadata } = result;
  return (
    <li className="flex flex-col gap-2 rounded-2xl border border-gray-200 p-4 dark:border-gray-700">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
          <input type="checkbox" checked={selected} onChange={onToggle} aria-label="Select for export" />
          {new Date(data.timestamp).toLocaleString()}
        </label>
        <div className="flex items-center gap-2">
          <StatusBadge status={data.status} />
          <ConnectionBadge type={data.via} />
        </div>
      </div>

      <div className="flex flex-col gap-1 text-sm text-gray-700 dark:text-gray-200">
        <div>
          <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Directional</p>
          {data.bandwidth.directional && data.bandwidth.directional.length > 0 ? (
            data.bandwidth.directional.map((edge, i) => <EdgeLine key={i} edge={edge} />)
          ) : (
            <p className="text-xs text-gray-500 dark:text-gray-400">Not measured</p>
          )}
        </div>
        {data.bandwidth.duplex && data.bandwidth.duplex.length > 0 && (
          <div>
            <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Duplex (secondary reading)
            </p>
            {data.bandwidth.duplex.map((edge, i) => <EdgeLine key={i} edge={edge} />)}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-x-3 text-xs text-gray-500 dark:text-gray-400">
        {data.peers.map((p) => (
          <span key={p.id}>
            {p.name}
            {" "}
            {p.ip || "IP Unknown"}
            {" "}
            {p.geo?.proxy && "proxy"}
            {p.geo?.hosting && "hosting"}
            {p.geo?.mobile && "cellular"}
          </span>
        ))}
      </div>

      <Link
        to={`/results/${data.room}/${metadata["peer-id"]}`}
        className="self-start text-sm font-medium text-gray-900 underline dark:text-gray-100"
      >
        View details
      </Link>
    </li>
  );
}

export default function Results({}: Route.ComponentProps) {
  const {
    state,
    selected,
    toggle,
    exportAll,
    exportSelected,
    importFile,
    importing,
    messages,
    keyFor,
    fileInputRef,
  } = useResultHistory();

  return (
    <main className="flex min-h-screen flex-col items-center gap-8 px-4 py-16">
      <div className="flex w-full max-w-2xl flex-col gap-2 text-center">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Results</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Stored on this device only. Each row is one browser's own honest account of a test —
          nothing here is compared against the other peer's copy.
        </p>
      </div>

      <div className="flex w-full max-w-2xl flex-wrap items-center justify-between gap-3 rounded-2xl border border-gray-200 p-4 dark:border-gray-700">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void exportAll()}
            disabled={state.status !== "ok" || state.results.length === 0}
            className="rounded-full border border-gray-300 px-4 py-2 text-sm font-medium text-gray-900 disabled:opacity-50 dark:border-gray-600 dark:text-gray-100"
          >
            Export all
          </button>
          <button
            type="button"
            onClick={() => void exportSelected()}
            disabled={selected.size === 0}
            className="rounded-full border border-gray-300 px-4 py-2 text-sm font-medium text-gray-900 disabled:opacity-50 dark:border-gray-600 dark:text-gray-100"
          >
            Export selected ({selected.size})
          </button>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void importFile(file);
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
            className="rounded-full bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900"
          >
            {importing ? "Importing…" : "Import"}
          </button>
        </div>
      </div>

      {messages.length > 0 && (
        <div className="flex w-full max-w-2xl flex-col gap-1 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
          {messages.map((m, i) => (
            <p key={i}>{m}</p>
          ))}
        </div>
      )}

      {state.status === "loading" && (
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
      )}

      {state.status === "error" && (
        <p className="text-sm text-red-600 dark:text-red-400">
          Couldn't read stored results ({state.reason}).
        </p>
      )}

      {state.status === "ok" && (
        <>
          {state.warnings.length > 0 && (
            <div className="flex w-full max-w-2xl flex-col gap-1 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
              {state.warnings.map((w, i) => (
                <p key={i}>{w}</p>
              ))}
            </div>
          )}

          {state.results.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              No results yet — run a test from a room to see it here.
            </p>
          ) : (
            <ul className="flex w-full max-w-2xl flex-col gap-3">
              {[...state.results]
                .sort((a, b) => Date.parse(b.data.timestamp) - Date.parse(a.data.timestamp))
                .map((result) => {
                  const key = keyFor(result);
                  return (
                    <ResultRow
                      key={key}
                      result={result}
                      selected={selected.has(key)}
                      onToggle={() => toggle(key)}
                    />
                  );
                })}
            </ul>
          )}
        </>
      )}
    </main>
  );
}
