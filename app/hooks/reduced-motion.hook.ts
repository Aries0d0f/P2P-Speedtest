import { useEffect, useState } from "react";

/**
 * `prefers-reduced-motion: reduce`, tracked live so a change during a run
 * takes effect immediately.
 *
 * Starts `false` so server rendering and the first client render agree; the
 * effect corrects it before the first frame of any animation.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduced(query.matches);
    apply();
    query.addEventListener?.("change", apply);
    return () => query.removeEventListener?.("change", apply);
  }, []);

  return reduced;
}
