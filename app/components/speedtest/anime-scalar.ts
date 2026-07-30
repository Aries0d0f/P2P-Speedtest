/**
 * A single retargetable Anime.js value (06-live-test-visualization 6.4).
 *
 * Phase 4 emits up to four progress updates a second for the whole run. The
 * failure mode this exists to prevent is spawning a fresh tween per update:
 * a few hundred orphaned animations by the end of a test, each still
 * ticking. `createAnimatable` gives one persistent animatable per value that
 * every update *retargets*, so the instance count is fixed at mount.
 *
 * Uses the `animejs/animatable` subpath so the room chunk does not pull in
 * timelines, draggables, or the WAAPI adapter.
 */

import { createAnimatable } from "animejs/animatable";

export interface AnimatedScalar {
  /** Retarget the tween. `immediate` lands the value synchronously — used for
   * reduced motion and for the first paint, so the DOM is never briefly
   * wrong. */
  set(value: number, immediate?: boolean): void;
  /** The value most recently asked for (not the interpolated one). */
  target(): number;
  dispose(): void;
}

export interface AnimatedScalarOptions {
  duration?: number;
  ease?: string;
  initial?: number;
}

export function createAnimatedScalar(
  write: (value: number) => void,
  options: AnimatedScalarOptions = {},
): AnimatedScalar {
  const duration = options.duration ?? 240;
  const initial = options.initial ?? 0;
  const state = { value: initial };
  let requested = initial;

  write(initial);

  // A plain object target rather than an element: the caller decides what a
  // number *means* (a needle angle, an arc length, a text node), so the same
  // primitive serves the gauge and the graph.
  const animatable = createAnimatable(state, {
    value: { duration, ease: options.ease ?? "outQuad" },
    onRender: () => write(state.value),
  }) as ReturnType<typeof createAnimatable> & {
    value: (to?: number, duration?: number) => unknown;
  };

  return {
    set(value: number, immediate = false) {
      if (!Number.isFinite(value)) return;
      requested = value;
      if (immediate) {
        animatable.value(value, 0);
        state.value = value;
        write(value);
        return;
      }
      animatable.value(value);
    },
    target: () => requested,
    dispose() {
      animatable.revert();
    },
  };
}
