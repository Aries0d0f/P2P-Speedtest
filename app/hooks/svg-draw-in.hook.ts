import { useEffect, type RefObject } from "react";

/**
 * A one-off draw-in the first time an SVG shape appears.
 *
 * Guarded because `createDrawable` needs `getTotalLength`, which jsdom does not
 * implement and which a hostile SVG state could make throw; a missing flourish
 * must never take the graph down. Runs once per mount, not per sample — the
 * dependency list is deliberately just `enabled`.
 */
export function useSvgDrawIn(
  ref: RefObject<SVGGraphicsElement | null>,
  enabled: boolean,
  options: { duration?: number; ease?: string } = {},
): void {
  const { duration = 420, ease = "outQuad" } = options;

  useEffect(() => {
    if (!enabled) return;
    const element = ref.current;
    if (!element) return;
    let cancelled = false;
    let animation: { revert: () => void } | null = null;

    void (async () => {
      try {
        const [{ createDrawable }, { animate }] = await Promise.all([
          import("animejs/svg"),
          import("animejs/animation"),
        ]);
        if (cancelled || !ref.current) return;
        const drawables = createDrawable(ref.current);
        animation = animate(drawables, { draw: "0 1", duration, ease });
      } catch (error) {
        console.debug("svg draw-in skipped", error);
      }
    })();

    return () => {
      cancelled = true;
      animation?.revert();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
}
