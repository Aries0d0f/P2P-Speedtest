import { useCallback, useEffect, useState } from "react";

/**
 * Imperative Three.js/Anime.js failures after mount cannot reach a React error
 * boundary, so they land here. This records the failure and lets the caller
 * swap the enhancement for a quiet panel; it dispatches no room event and
 * touches no measurement state. Sticky for the run, cleared by a new one.
 */
export function useVisualFailure(runId: string | null): {
  failed: boolean;
  onVisualError: (error: unknown) => void;
} {
  const [failed, setFailed] = useState(false);

  const onVisualError = useCallback((error: unknown) => {
    console.warn("live visualization unavailable", error);
    setFailed(true);
  }, []);

  useEffect(() => {
    setFailed(false);
  }, [runId]);

  return { failed, onVisualError };
}
