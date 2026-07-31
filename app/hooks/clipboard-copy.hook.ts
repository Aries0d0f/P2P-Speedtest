import { useCallback, useEffect, useRef, useState } from "react";

/** A "copied!" acknowledgement that clears itself. `kind` lets one hook serve
 * several buttons without either one clearing the other's label early. */
export function useClipboardCopy<K extends string>(resetMs = 2000): {
  copied: K | null;
  copy: (kind: K, value: string) => Promise<void>;
} {
  const [copied, setCopied] = useState<K | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const copy = useCallback(
    async (kind: K, value: string) => {
      try {
        await navigator.clipboard.writeText(value);
        setCopied(kind);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(null), resetMs);
      } catch (err) {
        console.warn(`Failed to copy ${kind}`, err);
      }
    },
    [resetMs],
  );

  return { copied, copy };
}
