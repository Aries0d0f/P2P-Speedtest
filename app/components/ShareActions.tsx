import { useState } from "react";
import { BsCopy, BsLink45Deg } from "react-icons/bs";
import { buildResultCopyText, buildResultLink, type P2PSpeedtestResult } from "~/lib/results";

/**
 * Copy-text and copy-link, identical on the room page's result state and
 * the results detail page (5.5) — the same pair of actions, and the same
 * honesty about a copied link only resolving on a browser that already
 * holds the record, wherever a result can be shared from.
 */
export function ShareActions({ result }: { result: P2PSpeedtestResult }) {
  const [copied, setCopied] = useState<"text" | "link" | null>(null);

  async function copy(kind: "text" | "link", value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      setTimeout(() => setCopied(null), 2000);
    } catch (err) {
      console.warn(`Failed to copy ${kind}`, err);
    }
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="flex flex-wrap justify-center gap-2">
        <button
          type="button"
          onClick={() => void copy("text", buildResultCopyText(result.data))}
          className="inline-flex items-center gap-2 rounded-full border border-gray-300 px-4 py-2 text-sm font-medium text-gray-900 dark:border-gray-600 dark:text-gray-100"
        >
          <BsCopy aria-hidden="true" />
          {copied === "text" ? "Copied!" : "Copy text"}
        </button>
        <button
          type="button"
          onClick={() =>
            void copy(
              "link",
              buildResultLink(window.location.origin, result.data.room, result.metadata["peer-id"]),
            )
          }
          className="inline-flex items-center gap-2 rounded-full border border-gray-300 px-4 py-2 text-sm font-medium text-gray-900 dark:border-gray-600 dark:text-gray-100"
        >
          <BsLink45Deg aria-hidden="true" />
          {copied === "link" ? "Copied!" : "Copy link"}
        </button>
      </div>
      <p className="max-w-xs text-center text-xs text-gray-500 dark:text-gray-400">
        The link only opens on a browser that already holds this record. Export it from the results
        list to share it with another device.
      </p>
    </div>
  );
}
