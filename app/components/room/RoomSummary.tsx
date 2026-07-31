import { BsCopy } from "react-icons/bs";

import { QrCode } from "~/components/QrCode";

export function RoomSummary({
  slug,
  emojiKey,
  link,
}: {
  slug: string;
  emojiKey: string;
  link: string;
}) {
  return (
    <section className="surface-panel flex w-full max-w-sm flex-col gap-3 rounded-2xl border border-gray-200 p-5 text-center dark:border-gray-700">
      <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
        Room ID
      </p>
      <div className="flex items-center justify-center gap-2">
        <p className="font-mono text-lg text-gray-900 dark:text-gray-100">
          <span className="after:content-['-'] after:px-1 after:text-gray-700 dark:after:text-gray-400">{slug.split("").slice(0, 3).join("")}</span>
          <span className="after:content-['-'] after:px-1 after:text-gray-700 dark:after:text-gray-400">{slug.split("").slice(3, 6).join("")}</span>
          <span>{slug.split("").slice(6, 9).join("")}</span>
        </p>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(slug).catch((error: unknown) => {
              console.warn("Failed to copy Room ID", error);
            });
          }}
          aria-label="Copy Room ID"
          title="Copy Room ID"
          className="w-6 rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100 mr-[-1.5rem] cursor-pointer"
        >
          <BsCopy aria-hidden="true" className="size-4" />
        </button>
      </div>
      <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
        Emoji key
      </p>
      <p className="text-2xl">{emojiKey}</p>
      <div className="flex justify-center">
        <QrCode value={link} />
      </div>
      <p className="break-all text-xs text-gray-500 dark:text-gray-400">{link}</p>
    </section>
  );
}
