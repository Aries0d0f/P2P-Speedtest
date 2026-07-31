import { useEffect, useState } from "react";

/**
 * A `<div>` at the very front of `<body>`, for a `position: fixed` layer that
 * must paint *under* the page.
 *
 * A positioned element paints after every non-positioned block in its stacking
 * context, so wherever such a layer sits inside the page it would cover the
 * content — and a negative z-index does not rescue it, because `body`'s own
 * background paints later still and hides it entirely. Hosting it first in
 * `<body>` and marking the route's `<main>` positioned lets plain document
 * order decide, with no z-index anywhere.
 */
export function usePortalHost(dataAttribute: string, warning?: string): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const element = document.createElement("div");
    element.setAttribute(dataAttribute, "");
    // `insertBefore(…, firstChild)` rather than `prepend`: the Workers runtime
    // types in this project declare their own `Element.prepend`
    // (HTMLRewriter's), which shadows the DOM signature.
    document.body.insertBefore(element, document.body.firstChild);
    setHost(element);

    // The route's `<main>` must be positioned or it paints *below* this layer
    // and the page disappears. That coupling is invisible from the route, so
    // say so loudly in development. Stripped from production builds.
    if (import.meta.env.DEV && warning) {
      const main = document.querySelector("main");
      if (main && getComputedStyle(main).position === "static") {
        console.warn(warning);
      }
    }

    return () => {
      element.remove();
      setHost(null);
    };
  }, [dataAttribute, warning]);

  return host;
}
