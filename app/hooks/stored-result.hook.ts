import { useEffect, useState } from "react";

import { getResult } from "~/lib/results-store";
import type { P2PSpeedtestResult } from "~/model/result.model";

/** Client-only storage (5.1) — see `result-history.hook.ts` for why "loading"
 * is the stable SSR/first-paint state. `not-found` and `invalid` stay distinct:
 * a record this browser never had is not the same fact as a corrupted one. */
export type StoredResultState =
  | { status: "loading" }
  | { status: "ok"; result: P2PSpeedtestResult }
  | { status: "not-found" }
  | { status: "invalid"; errors: string[] }
  | { status: "error"; reason: string };

export function useStoredResult(room: string, peerId: string): { state: StoredResultState } {
  const [state, setState] = useState<StoredResultState>({ status: "loading" });

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

  return { state };
}
