import { Link } from "react-router";

import { ResultDetailBody } from "~/components/room/ResultDetailBody";
import { useStoredResult } from "~/hooks/stored-result.hook";

import type { Route } from "./+types/results.$room.$peerId";

export function meta({}: Route.MetaArgs) {
  return [{ title: "P2P Speedtest — Result" }];
}

export default function ResultDetail({ params }: Route.ComponentProps) {
  const { room, peerId } = params;
  const { state } = useStoredResult(room, peerId);

  // `relative`: see the note in room.tsx — the globe layer is a fixed element
  // portalled to the front of <body>, so the page has to be positioned too for
  // document order, rather than a z-index, to put it on top.
  return (
    <main className="relative flex min-h-screen flex-col items-center gap-6 px-4 py-16">
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

      {state.status === "ok" && <ResultDetailBody result={state.result} />}
    </main>
  );
}
