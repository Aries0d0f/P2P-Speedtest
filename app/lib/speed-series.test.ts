import { describe, expect, it } from "vitest";

import type { Slot } from "~/model/signaling.model";
import { DOWNLOAD, DUPLEX, UPLOAD, edgeKey, type StageId } from "~/model/stage.model";
import { emptySpeedSeries, latest, niceCeiling, recordSample, totalPoints } from "~/lib/speed-series";
import { MAX_POINTS_PER_SERIES, type SpeedSeriesState } from "~/model/speed-series.model";
import type { TransferChannel } from "~/model/presentation.model";

const RUN = "run-1";

let sampleCounter = 0;

function channel(
  stageId: StageId,
  receiverSlot: Slot,
  mbps: number | null,
  over: Partial<TransferChannel> = {},
): TransferChannel {
  return {
    stageId,
    senderSlot: receiverSlot === 0 ? 1 : 0,
    receiverSlot,
    role: receiverSlot === 0 ? "receive" : "send",
    token: "--transfer-receive",
    label: receiverSlot === 0 ? "You receive" : "You send",
    mbps,
    loss: null,
    key: edgeKey(stageId, receiverSlot),
    // Unique by default so each call is a genuinely new observation; tests
    // that care about deduplication pass an explicit key.
    sampleKey: `s${sampleCounter++}`,
    ...over,
  };
}

function feed(
  state: SpeedSeriesState,
  channels: TransferChannel[],
  nowMs: number,
  runId: string | null = RUN,
): SpeedSeriesState {
  return recordSample(state, { runId, nowMs, channels });
}

describe("niceCeiling", () => {
  it("snaps to the smallest 1/2/5 decade at or above the value", () => {
    expect(niceCeiling(0.4)).toBe(0.5);
    expect(niceCeiling(1)).toBe(1);
    expect(niceCeiling(1.6)).toBe(2);
    expect(niceCeiling(4)).toBe(5);
    expect(niceCeiling(9)).toBe(10);
    expect(niceCeiling(94)).toBe(100);
    expect(niceCeiling(180)).toBe(200);
    expect(niceCeiling(430)).toBe(500);
    expect(niceCeiling(2400)).toBe(5000);
  });

  it("never sits below the value it has to display", () => {
    for (const v of [1, 7.3, 55, 100, 480, 3300]) {
      expect(niceCeiling(v)).toBeGreaterThanOrEqual(v);
    }
  });

  it("handles zero and nonsense defensively", () => {
    expect(niceCeiling(0)).toBe(1);
    expect(niceCeiling(-5)).toBe(1);
    expect(niceCeiling(Number.NaN)).toBe(1);
  });
});

describe("recordSample", () => {
  it("starts a series on the first reading", () => {
    const state = feed(emptySpeedSeries(), [channel(DOWNLOAD, 1, 10)], 1000);
    expect(state.series).toHaveLength(1);
    expect(state.series[0].key).toBe(edgeKey(DOWNLOAD, 1));
    expect(state.series[0].points).toEqual([{ t: 0, mbps: 10 }]);
    // Each series' origin is its own first sample, not the caller's clock
    // zero and not the run's start.
    expect(state.series[0].originMs).toBe(1000);
  });

  it("records elapsed time relative to that series' own origin", () => {
    let state = feed(emptySpeedSeries(), [channel(DOWNLOAD, 1, 10)], 1000);
    state = feed(state, [channel(DOWNLOAD, 1, 12)], 1250);
    expect(state.series[0].points.map((p) => p.t)).toEqual([0, 250]);
    expect(state.spanMs).toBe(250);
  });

  it("drops a repeated snapshot instead of drawing it twice", () => {
    let state = feed(emptySpeedSeries(), [channel(DOWNLOAD, 1, 10, { sampleKey: "a" })], 1000);
    const before = state;
    state = feed(state, [channel(DOWNLOAD, 1, 10, { sampleKey: "a" })], 1100);
    expect(state).toBe(before); // same object: a consumer can skip the render
    expect(state.series[0].points).toHaveLength(1);

    state = feed(state, [channel(DOWNLOAD, 1, 10, { sampleKey: "b" })], 1200);
    // A genuinely new observation with the same value is still a new point.
    expect(state.series[0].points).toHaveLength(2);
  });

  it("ignores a channel with no reading rather than recording zero", () => {
    const state = feed(emptySpeedSeries(), [channel(UPLOAD, 0, null)], 1000);
    expect(state.series).toEqual([]);
    expect(state.spanMs).toBe(0);
  });

  it("records a genuine zero reading", () => {
    const state = feed(emptySpeedSeries(), [channel(UPLOAD, 0, 0)], 1000);
    expect(state.series[0].points).toEqual([{ t: 0, mbps: 0 }]);
  });

  it("ignores non-finite and negative values", () => {
    let state = feed(emptySpeedSeries(), [channel(UPLOAD, 0, Number.NaN)], 1000);
    state = feed(state, [channel(UPLOAD, 0, Number.POSITIVE_INFINITY)], 1100);
    state = feed(state, [channel(UPLOAD, 0, -3)], 1200);
    expect(state.series).toEqual([]);
  });
});

describe("stage separation", () => {
  it("gives each stage its own series so no diagonal joins them", () => {
    let state = feed(emptySpeedSeries(), [channel(DOWNLOAD, 1, 10)], 0);
    state = feed(state, [channel(DOWNLOAD, 1, 11)], 250);
    state = feed(state, [channel(UPLOAD, 0, 40)], 8000);
    state = feed(state, [channel(UPLOAD, 0, 42)], 8250);

    expect(state.series.map((s) => s.key)).toEqual([edgeKey(DOWNLOAD, 1), edgeKey(UPLOAD, 0)]);
    expect(state.series[0].points).toHaveLength(2);
    expect(state.series[1].points).toHaveLength(2);
    // Both stages start at zero and overlay, rather than the later one being
    // pushed 8 seconds to the right with dead plot between them.
    expect(state.series[0].points.map((p) => p.t)).toEqual([0, 250]);
    expect(state.series[1].points.map((p) => p.t)).toEqual([0, 250]);
    expect(latest(state.series[0])!.t).toBe(250);
    // They are still separate polylines, so no diagonal joins the stages.
    expect(state.series[0].key).not.toBe(state.series[1].key);
  });

  it("makes the span the longest stage, not the whole run", () => {
    let state = feed(emptySpeedSeries(), [channel(DOWNLOAD, 1, 10)], 0);
    state = feed(state, [channel(DOWNLOAD, 1, 11)], 5_000);
    state = feed(state, [channel(UPLOAD, 0, 40)], 60_000);
    state = feed(state, [channel(UPLOAD, 0, 42)], 62_000);
    expect(state.spanMs).toBe(5_000);
  });

  it("keeps the two duplex directions on a common origin", () => {
    // They start together in reality, so they must start together on screen:
    // a stagger here would read as one direction lagging the other.
    const state = feed(emptySpeedSeries(), [channel(DUPLEX, 0, 10), channel(DUPLEX, 1, 25)], 4_000);
    expect(state.series.map((s) => s.originMs)).toEqual([4_000, 4_000]);
    expect(state.series.every((s) => s.points[0].t === 0)).toBe(true);
  });

  it("keeps the two duplex directions as independent series", () => {
    let state = feed(
      emptySpeedSeries(),
      [channel(DUPLEX, 0, 10), channel(DUPLEX, 1, 25)],
      0,
    );
    state = feed(state, [channel(DUPLEX, 0, 12), channel(DUPLEX, 1, 27)], 250);

    expect(state.series).toHaveLength(2);
    expect(state.series.map((s) => latest(s)!.mbps)).toEqual([12, 27]);
    // No combined series exists, so nothing downstream can plot a total.
    expect(state.series.some((s) => s.key === edgeKey(DUPLEX, 0))).toBe(true);
    expect(state.series.some((s) => s.key === edgeKey(DUPLEX, 1))).toBe(true);
  });

  it("preserves the direction and label of each series", () => {
    const state = feed(
      emptySpeedSeries(),
      [
        channel(DUPLEX, 0, 10, { role: "receive", label: "You receive", token: "--transfer-duplex" }),
        channel(DUPLEX, 1, 20, { role: "send", label: "You send", token: "--transfer-duplex" }),
      ],
      0,
    );
    expect(state.series.map((s) => s.role)).toEqual(["receive", "send"]);
    expect(state.series.map((s) => s.label)).toEqual(["You receive", "You send"]);
    expect(state.series.every((s) => s.token === "--transfer-duplex")).toBe(true);
  });
});

describe("monotonic scale", () => {
  it("rises with a faster reading", () => {
    let state = feed(emptySpeedSeries(), [channel(DOWNLOAD, 1, 8)], 0);
    expect(state.ceiling).toBe(10);
    state = feed(state, [channel(DOWNLOAD, 1, 180)], 250);
    expect(state.ceiling).toBe(200);
  });

  it("never falls back within a run, so stages stay comparable", () => {
    let state = feed(emptySpeedSeries(), [channel(DOWNLOAD, 1, 400)], 0);
    const peak = state.ceiling;
    state = feed(state, [channel(UPLOAD, 0, 3)], 8000);
    expect(state.ceiling).toBe(peak);
  });

  it("starts at a sane floor before any reading", () => {
    expect(emptySpeedSeries().ceiling).toBe(1);
  });

  it("copes with a very large speed", () => {
    const state = feed(emptySpeedSeries(), [channel(DOWNLOAD, 1, 24_000)], 0);
    expect(state.ceiling).toBeGreaterThanOrEqual(24_000);
    expect(Number.isFinite(state.ceiling)).toBe(true);
  });
});

describe("bounds", () => {
  it("decimates rather than growing without bound", () => {
    let state = emptySpeedSeries();
    for (let i = 0; i < MAX_POINTS_PER_SERIES * 6; i++) {
      state = feed(state, [channel(DOWNLOAD, 1, 10 + (i % 5))], i * 250);
    }
    expect(state.series[0].points.length).toBeLessThanOrEqual(MAX_POINTS_PER_SERIES);
    expect(state.series[0].seen).toBe(MAX_POINTS_PER_SERIES * 6);
    expect(state.series[0].stride).toBeGreaterThan(1);
  });

  it("keeps the newest sample at the live end of the trace", () => {
    let state = emptySpeedSeries();
    for (let i = 0; i < MAX_POINTS_PER_SERIES + 10; i++) {
      state = feed(state, [channel(DOWNLOAD, 1, i)], i * 250);
    }
    const last = latest(state.series[0])!;
    expect(last.mbps).toBe(MAX_POINTS_PER_SERIES + 9);
    expect(last.t).toBe((MAX_POINTS_PER_SERIES + 9) * 250);
  });

  it("still covers the whole stage after decimating", () => {
    let state = emptySpeedSeries();
    for (let i = 0; i < MAX_POINTS_PER_SERIES * 3; i++) {
      state = feed(state, [channel(DOWNLOAD, 1, 10)], i * 250);
    }
    // Decimation thins the trace; it does not drop the start of the stage.
    expect(state.series[0].points[0].t).toBe(0);
  });

  it("holds at most four series for a complete run", () => {
    let state = emptySpeedSeries();
    state = feed(state, [channel(DOWNLOAD, 1, 10)], 0);
    state = feed(state, [channel(UPLOAD, 0, 10)], 1000);
    state = feed(state, [channel(DUPLEX, 0, 10), channel(DUPLEX, 1, 10)], 2000);
    state = feed(state, [channel(DUPLEX, 0, 11), channel(DUPLEX, 1, 11)], 2250);
    expect(state.series).toHaveLength(4);
    expect(totalPoints(state)).toBe(6);
  });
});

describe("run reset", () => {
  it("wipes series, ceiling and origin when the run changes", () => {
    let state = feed(emptySpeedSeries(), [channel(DOWNLOAD, 1, 500)], 1000);
    state = feed(state, [channel(DOWNLOAD, 1, 20)], 5000, "run-2");
    expect(state.runId).toBe("run-2");
    expect(state.series).toHaveLength(1);
    expect(state.series[0].points).toEqual([{ t: 0, mbps: 20 }]);
    expect(state.ceiling).toBe(niceCeiling(20));
    expect(state.series[0].originMs).toBe(5000);
    expect(state.spanMs).toBe(0);
  });

  it("treats a null run id as its own run", () => {
    let state = feed(emptySpeedSeries(), [channel(DOWNLOAD, 1, 10)], 0, null);
    expect(state.series).toHaveLength(1);
    state = feed(state, [channel(DOWNLOAD, 1, 10)], 1000, RUN);
    expect(state.runId).toBe(RUN);
    expect(state.series[0].points).toHaveLength(1);
  });
});

describe("purity", () => {
  it("does not mutate the previous state", () => {
    const first = feed(emptySpeedSeries(), [channel(DOWNLOAD, 1, 10)], 0);
    const snapshot = JSON.stringify(first);
    feed(first, [channel(DOWNLOAD, 1, 20)], 250);
    expect(JSON.stringify(first)).toBe(snapshot);
  });

  it("returns the identical object when nothing was recorded", () => {
    const state = feed(emptySpeedSeries(), [channel(DOWNLOAD, 1, 10, { sampleKey: "x" })], 0);
    expect(feed(state, [channel(DOWNLOAD, 1, 10, { sampleKey: "x" })], 250)).toBe(state);
    expect(feed(state, [], 500)).toBe(state);
    expect(feed(state, [channel(UPLOAD, 0, null)], 750)).toBe(state);
  });
});
