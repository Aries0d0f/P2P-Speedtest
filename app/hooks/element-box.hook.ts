import { useEffect, useState, type RefObject } from "react";

export interface ElementBox {
  width: number;
  height: number;
}

const ZERO: ElementBox = { width: 0, height: 0 };

/**
 * Content-box sizes for several elements, from **one** `ResizeObserver`
 * dispatching by `entry.target`. Two observers would change resize-callback
 * ordering between the boxes, which the globe's reference/layer pair depends
 * on. A ref whose element is absent keeps its zero box.
 *
 * `resetKey` re-runs the subscription — used when an element only appears
 * after some other state lands.
 */
export function useElementBoxes(
  refs: ReadonlyArray<RefObject<Element | null>>,
  resetKey?: unknown,
): ElementBox[] {
  const [boxes, setBoxes] = useState<ElementBox[]>(() => refs.map(() => ZERO));

  useEffect(() => {
    if (typeof ResizeObserver !== "function") return;

    const elements = refs.map((ref) => ref.current);
    if (elements.every((el) => el === null)) return;

    const apply = (index: number, rect: { width: number; height: number }) =>
      setBoxes((prev) => {
        const current = prev[index] ?? ZERO;
        if (current.width === rect.width && current.height === rect.height) return prev;
        const next = prev.slice();
        next[index] = { width: rect.width, height: rect.height };
        return next;
      });

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const index = elements.indexOf(entry.target);
        if (index >= 0) apply(index, entry.contentRect);
      }
    });

    elements.forEach((element, index) => {
      if (!element) return;
      observer.observe(element);
      apply(index, element.getBoundingClientRect());
    });

    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, refs.length]);

  return boxes;
}
