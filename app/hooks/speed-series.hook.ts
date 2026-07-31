import { useEffect, useState } from "react";

import { emptySpeedSeries, recordSample } from "~/lib/speed-series";
import type { LiveTestPresentation } from "~/model/presentation.model";
import type { SpeedSeriesState } from "~/model/speed-series.model";

/**
 * The run-scoped series, fed from presentation snapshots only.
 *
 * `recordSample` returns the identical object when a render carries no new
 * observation, so a duplicate render costs one comparison.
 */
export function useSpeedSeries(presentation: LiveTestPresentation): {
  series: SpeedSeriesState;
} {
  const [series, setSeries] = useState<SpeedSeriesState>(emptySpeedSeries);

  useEffect(() => {
    const nowMs = typeof performance !== "undefined" ? performance.now() : 0;
    setSeries((previous) =>
      recordSample(previous, {
        runId: presentation.runId,
        nowMs,
        channels: presentation.channels,
      }),
    );
  }, [presentation]);

  return { series };
}
