import type { TerminalReason } from "~/model/room.model";

import { terminalMessage, terminalTone } from "./terminal-copy";

export function TerminalPanel({ reason }: { reason: TerminalReason }) {
  return (
    <>
      <p
        className={
          terminalTone(reason) === "error"
            ? "text-red-600 dark:text-red-400"
            : "text-gray-700 dark:text-gray-200"
        }
      >
        {terminalMessage(reason)}
      </p>
      <a
        href="/"
        className="rounded-full border border-gray-300 px-4 py-2 text-sm font-medium text-gray-900 dark:border-gray-600 dark:text-gray-100"
      >
        Start a new room
      </a>
    </>
  );
}
