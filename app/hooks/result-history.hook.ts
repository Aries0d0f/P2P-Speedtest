import { useCallback, useEffect, useRef, useState } from "react";

import { exportResults, importResults, listResults } from "~/lib/results-store";
import type { P2PSpeedtestResult } from "~/model/result.model";
import type { ImportEntryResult } from "~/model/storage.model";

/** Client-only storage (5.1): the server has no IndexedDB, so this starts in
 * "loading" both during SSR and on the client's first paint, and only resolves
 * after mount — hydration never disagrees with what the server sent. */
export type ResultHistoryState =
  | { status: "loading" }
  | { status: "ok"; results: P2PSpeedtestResult[]; warnings: string[] }
  | { status: "error"; reason: string };

export interface ResultHistoryHandle {
  state: ResultHistoryState;
  selected: ReadonlySet<string>;
  toggle: (key: string) => void;
  exportAll: () => Promise<void>;
  exportSelected: () => Promise<void>;
  importFile: (file: File) => Promise<void>;
  importing: boolean;
  messages: string[];
  /** `[room, peerId]` — the compound key every row is stored under. */
  keyFor: (result: P2PSpeedtestResult) => string;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
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

export function useResultHistory(): ResultHistoryHandle {
  const [state, setState] = useState<ResultHistoryState>({ status: "loading" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [messages, setMessages] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    const listed = await listResults();
    setState(
      listed.status === "ok"
        ? { status: "ok", results: listed.results, warnings: listed.warnings }
        : { status: "error", reason: listed.reason },
    );
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const doExport = useCallback(
    async (onlySelected: boolean) => {
      if (state.status !== "ok") return;
      const keys =
        onlySelected && selected.size > 0
          ? state.results
              .filter((r) => selected.has(keyFor(r)))
              .map((r): [string, string] => [r.data.room, r.metadata["peer-id"]])
          : undefined;
      await exportResults(keys);
    },
    [state, selected],
  );

  const importFile = useCallback(
    async (file: File) => {
      setImporting(true);
      try {
        const outcome = await importResults(file);
        if (outcome.status === "malformed-file") {
          setMessages([
            "This file isn't a valid export — expected a { results: [...] } JSON file.",
          ]);
          return;
        }
        setMessages(outcome.entries.map(describeImportEntry));
        await refresh();
      } finally {
        setImporting(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [refresh],
  );

  return {
    state,
    selected,
    toggle: useCallback((key: string) => {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    }, []),
    exportAll: useCallback(() => doExport(false), [doExport]),
    exportSelected: useCallback(() => doExport(true), [doExport]),
    importFile,
    importing,
    messages,
    keyFor,
    fileInputRef,
  };
}
