import { useEffect, useRef } from "react";

import {
  createAnimatedScalar,
  type AnimatedScalar,
  type AnimatedScalarOptions,
} from "~/components/speedtest/anime-scalar";

/**
 * One retargetable Anime.js value for the life of the component.
 *
 * `deps` reproduces the cases where the write target itself changes shape and
 * the animatable genuinely has to be rebuilt; everything else retargets the
 * same instance, so the instance count is fixed at mount rather than growing
 * by one per progress update.
 */
export function useAnimatedScalar(
  write: (value: number) => void,
  options: AnimatedScalarOptions = {},
  deps: readonly unknown[] = [],
): { set: (value: number, immediate?: boolean) => void } {
  const scalarRef = useRef<AnimatedScalar | null>(null);
  const writeRef = useRef(write);
  writeRef.current = write;

  useEffect(() => {
    const scalar = createAnimatedScalar((value) => writeRef.current(value), options);
    scalarRef.current = scalar;
    return () => {
      scalar.dispose();
      scalarRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return {
    set: (value: number, immediate?: boolean) => scalarRef.current?.set(value, immediate),
  };
}
