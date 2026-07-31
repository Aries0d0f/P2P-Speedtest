import { useEffect, useState } from "react";

/** Page Visibility, tracked live. Starts `true` so SSR and the first client
 * render agree. */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const apply = () => setVisible(!document.hidden);
    apply();
    document.addEventListener("visibilitychange", apply);
    return () => document.removeEventListener("visibilitychange", apply);
  }, []);

  return visible;
}
