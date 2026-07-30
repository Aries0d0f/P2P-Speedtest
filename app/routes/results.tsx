import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ConnectionBadge } from "~/components/ConnectionBadge";
import {
  bpsToMbps,
  exportResults,
  importResults,
  listResults,
  type BandwidthEdge,
  type ImportEntryResult,
  type P2PSpeedtestResult,
  type ResultStatus,
} from "~/lib/results";

import type { Route } from "./+types/results";

export function meta({}: Route.MetaArgs) {
  return [{ title: "P2P Speedtest — Results" }];
}

// Client-only storage (5.1): the server has no IndexedDB, so this starts in
// "loading" both during SSR and on the client's first paint, and only ever
// resolves after the mount effect below runs — hydration never disagrees
// with what the server sent.
type LoadState =
  | { status: "loading" }
  | { status: "ok"; results: P2PSpeedtestResult[]; warnings: string[] }
  | { status: "error"; reason: string };

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

function keyFor(result: P2PSpeedtestResult): string {
  return `${result.data.room} ${result.metadata["peer-id"]}`;
}

function describeImportEntry(entry: ImportEntryResult): string {
  const n = entry.index + 1;
  switch (entry.outcome.status) {
    case "saved":
      return `Entry ${n}: saved.`;
    case "deduplicated":
      return `Entry ${n}: already had this result — skipped.`;
    case "malformed":
      return `Entry ${n}: skipped — ${entry.outcome.message}.`;
    case "unsupported-version":
      return `Entry ${n}: skipped — ${entry.outcome.message}.`;
    case "invalid":
      return `Entry ${n}: rejected — ${entry.outcome.errors.join("; ")}`;
    case "save-error":
      return `Entry ${n}: could not be saved (${entry.outcome.reason}).`;
  }
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
          <span key={p.id}>{p.name}</span>
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
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importMessages, setImportMessages] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function refresh() {
    const listed = await listResults();
    setState(
      listed.status === "ok"
        ? { status: "ok", results: listed.results, warnings: listed.warnings }
        : { status: "error", reason: listed.reason },
    );
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleExport(onlySelected: boolean) {
    if (state.status !== "ok") return;
    const keys =
      onlySelected && selected.size > 0
        ? state.results
            .filter((r) => selected.has(keyFor(r)))
            .map((r): [string, string] => [r.data.room, r.metadata["peer-id"]])
        : undefined;
    await exportResults(keys);
  }

  async function handleImportFile(file: File) {
    setImporting(true);
    try {
      const outcome = await importResults(file);
      if (outcome.status === "malformed-file") {
        setImportMessages(["This file isn't a valid export — expected a { results: [...] } JSON file."]);
        return;
      }
      setImportMessages(outcome.entries.map(describeImportEntry));
      await refresh();
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

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
            onClick={() => void handleExport(false)}
            disabled={state.status !== "ok" || state.results.length === 0}
            className="rounded-full border border-gray-300 px-4 py-2 text-sm font-medium text-gray-900 disabled:opacity-50 dark:border-gray-600 dark:text-gray-100"
          >
            Export all
          </button>
          <button
            type="button"
            onClick={() => void handleExport(true)}
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
              if (file) void handleImportFile(file);
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

      {importMessages.length > 0 && (
        <div className="flex w-full max-w-2xl flex-col gap-1 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
          {importMessages.map((m, i) => (
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
                      onToggle={() =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        })
                      }
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
