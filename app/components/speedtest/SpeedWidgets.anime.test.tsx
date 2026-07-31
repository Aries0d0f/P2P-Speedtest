import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StageProgress } from "~/model/measurement.model";
import type { Slot } from "~/model/signaling.model";
import { DOWNLOAD, DUPLEX, edgeKey, type StageId } from "~/model/stage.model";
import { emptySpeedSeries, recordSample } from "~/lib/speed-series";
import type { SpeedSeriesState } from "~/model/speed-series.model";
import { selectLiveTestPresentation } from "~/lib/presentation-selector";
import type { LiveTestPresentation, LiveTestRoomView } from "~/model/presentation.model";

/**
 * Anime.js instance hygiene (06-live-test-visualization 6.4).
 *
 * The failure this file exists to catch is silent: at four progress updates a
 * second, a widget that *creates* a tween per update instead of retargeting
 * one accumulates hundreds of live animations over a run and turns into a
 * memory and main-thread leak during an otherwise healthy test.
 *
 * `anime-scalar` is mocked for the whole file, so every instance created and
 * disposed is counted.
 */

interface ScalarRecord {
  sets: number[];
  disposed: boolean;
}

const instances: ScalarRecord[] = [];

vi.mock("./anime-scalar", () => ({
  createAnimatedScalar: (write: (value: number) => void) => {
    const record: ScalarRecord = { sets: [], disposed: false };
    instances.push(record);
    write(0);
    return {
      set(value: number) {
        record.sets.push(value);
        write(value);
      },
      target: () => record.sets.at(-1) ?? 0,
      dispose() {
        record.disposed = true;
      },
    };
  },
}));

const { RealtimeSpeedGraph } = await import("./RealtimeSpeedGraph");
const { SpeedGauge } = await import("./SpeedGauge");

const RUN = "run-1";

function snapshot(stageId: StageId, receiverSlot: Slot, bytes: number, elapsedMs = 1000): StageProgress {
  return { stageId, receiverSlot, bytes, elapsedMs, chunksSeen: 100, highestSeqPlusOne: 100 };
}

function presentationFor(over: Partial<LiveTestRoomView> = {}, localSlot: Slot = 0): LiveTestPresentation {
  const view: LiveTestRoomView = {
    runId: RUN,
    phase: "testing",
    stageId: null,
    stageProgress: { runId: RUN, entries: {} },
    liveLatency: null,
    latencyBaseline: undefined,
    connectionType: "DIRECT",
    selfProfile: { name: "Local" },
    otherProfile: { name: "Remote" },
    ...over,
  };
  return selectLiveTestPresentation(view, localSlot);
}

function seriesFrom(presentations: LiveTestPresentation[]): SpeedSeriesState {
  let state = emptySpeedSeries();
  presentations.forEach((p, i) => {
    state = recordSample(state, { runId: p.runId, nowMs: i * 250, channels: p.channels });
  });
  return state;
}

beforeEach(() => {
  instances.length = 0;
});

describe("gauge", () => {
  const withBytes = (bytes: number, elapsedMs: number) =>
    presentationFor({
      stageId: DOWNLOAD,
      stageProgress: { runId: RUN, entries: { [edgeKey(DOWNLOAD, 1)]: snapshot(DOWNLOAD, 1, bytes, elapsedMs) } },
    });

  it("creates one animatable per channel and retargets it thereafter", () => {
    // A ceiling well above every sample, so each update really does move the
    // needle rather than being clamped to full scale.
    const { rerender } = render(<SpeedGauge presentation={withBytes(1_250_000, 1000)} ceiling={1000} />);
    expect(instances).toHaveLength(1);

    for (let i = 2; i <= 20; i++) {
      rerender(<SpeedGauge presentation={withBytes(1_250_000 * i, 1000)} ceiling={1000} />);
    }

    // Nineteen further updates; still exactly one animatable, each update a
    // retarget rather than an orphaned tween.
    expect(instances).toHaveLength(1);
    expect(instances[0].sets.length).toBeGreaterThanOrEqual(19);
  });

  it("cancels every animatable on unmount", () => {
    const { unmount } = render(<SpeedGauge presentation={withBytes(1_250_000, 1000)} ceiling={100} />);
    unmount();
    expect(instances.every((i) => i.disposed)).toBe(true);
  });

  it("uses one animatable per duplex direction, never a shared one", () => {
    render(
      <SpeedGauge
        presentation={presentationFor({
          stageId: DUPLEX,
          stageProgress: { runId: RUN, entries: {
            [edgeKey(DUPLEX, 0)]: snapshot(DUPLEX, 0, 1_250_000),
            [edgeKey(DUPLEX, 1)]: snapshot(DUPLEX, 1, 2_500_000),
          } },
        })}
        ceiling={100}
      />,
    );
    expect(instances).toHaveLength(2);
  });

  it("disposes the previous channel's animatable when the stage changes", () => {
    const { rerender } = render(<SpeedGauge presentation={withBytes(1_250_000, 1000)} ceiling={100} />);
    expect(instances).toHaveLength(1);

    rerender(
      <SpeedGauge
        presentation={presentationFor({
          stageId: DUPLEX,
          stageProgress: { runId: RUN, entries: { [edgeKey(DUPLEX, 0)]: snapshot(DUPLEX, 0, 1_250_000) } },
        })}
        ceiling={100}
      />,
    );

    expect(instances[0].disposed).toBe(true);
    expect(instances.filter((i) => !i.disposed)).toHaveLength(2);
  });
});

describe("graph", () => {
  it("creates one readout animatable per series and retargets it", () => {
    let state = seriesFrom([
      presentationFor({
        stageId: DOWNLOAD,
        stageProgress: { runId: RUN, entries: { [edgeKey(DOWNLOAD, 1)]: snapshot(DOWNLOAD, 1, 1_250_000) } },
      }),
    ]);
    const { rerender } = render(<RealtimeSpeedGraph state={state} />);
    expect(instances).toHaveLength(1);

    for (let i = 2; i <= 20; i++) {
      state = recordSample(state, {
        runId: RUN,
        nowMs: i * 250,
        channels: presentationFor({
          stageId: DOWNLOAD,
          stageProgress: { runId: RUN, entries: { [edgeKey(DOWNLOAD, 1)]: snapshot(DOWNLOAD, 1, 1_250_000 * i, 1000) } },
        }).channels,
      });
      rerender(<RealtimeSpeedGraph state={state} />);
    }

    expect(instances).toHaveLength(1);
    expect(screen.getByTestId(`readout-${edgeKey(DOWNLOAD, 1)}`).textContent).toBe("200");
  });

  it("cancels every readout animatable on unmount", () => {
    const state = seriesFrom([
      presentationFor({
        stageId: DUPLEX,
        stageProgress: { runId: RUN, entries: {
          [edgeKey(DUPLEX, 0)]: snapshot(DUPLEX, 0, 1_250_000),
          [edgeKey(DUPLEX, 1)]: snapshot(DUPLEX, 1, 2_500_000),
        } },
      }),
    ]);
    const { unmount } = render(<RealtimeSpeedGraph state={state} />);
    expect(instances).toHaveLength(2);
    unmount();
    expect(instances.every((i) => i.disposed)).toBe(true);
  });
});
