/** The bounded, run-scoped series behind the live graph and gauge (6.4). */

import type { StageId } from "./stage.model";
import type { TransferToken } from "./presentation.model";

/** Points kept per series before decimation halves the resolution. At four
 * updates a second, this is a full minute of a single stage. */
export const MAX_POINTS_PER_SERIES = 240;

export interface SeriesPoint {
  /** Milliseconds since this *series'* first sample — not the run's, so the
   * three stages overlay for comparison instead of being strung out along the
   * run with dead gaps between them. */
  t: number;
  mbps: number;
}

export interface Series {
  /** `edgeKey(stageId, receiverSlot)` — unique within a run. */
  key: string;
  stageId: StageId;
  role: "receive" | "send";
  token: TransferToken;
  label: string;
  /** Wall clock of this series' first sample; the origin of its own `t`. */
  originMs: number;
  points: SeriesPoint[];
  /** Every `stride`-th sample is kept; doubles when the buffer fills. */
  stride: number;
  /** Samples seen, including those decimated away. */
  seen: number;
  /** Dedup guard: the last snapshot identity folded in. */
  lastSampleKey: string | null;
}

export interface SpeedSeriesState {
  runId: string | null;
  /** In first-sample order, so stages read left to right. */
  series: Series[];
  /** Monotonic "nice" y-axis ceiling in Mbps. */
  ceiling: number;
  /** The longest series' duration — the shared x-axis extent. Monotonic, so a
   * later short stage never squeezes an earlier long one. */
  spanMs: number;
}
