import { useRef, type RefObject } from "react";

/**
 * The current value, readable from a callback that outlives the render it was
 * created in.
 *
 * Every room sub-hook registers its listeners once per run, so a callback that
 * closed over a prop would go stale the moment any sibling hook updated. Going
 * through this ref instead is what lets those callbacks be plain inline
 * closures at the call site — including ones that reach *forward* to a hook
 * declared later in the composite, exactly as the original single effect's
 * hoisted function declarations did.
 */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
