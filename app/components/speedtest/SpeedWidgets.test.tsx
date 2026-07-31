import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { StageProgress } from "~/model/measurement.model";
import type { Slot } from "~/model/signaling.model";
import { DOWNLOAD, DUPLEX, UPLOAD, edgeKey, type StageId } from "~/model/stage.model";
import { emptySpeedSeries, recordSample } from "~/lib/speed-series";
import type { SpeedSeriesState } from "~/model/speed-series.model";
import { selectLiveTestPresentation } from "~/lib/presentation-selector";
import type { LiveTestPresentation, LiveTestRoomView } from "~/model/presentation.model";

import { RealtimeSpeedGraph } from "./RealtimeSpeedGraph";
import { SpeedGauge } from "./SpeedGauge";

const RUN = "run-1";

function snapshot(
  stageId: StageId,
  receiverSlot: Slot,
  bytes: number,
  elapsedMs = 1000,
): StageProgress {
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

// Deliberately no fake timers in this file: Anime.js drives its own
// `requestAnimationFrame` clock, and swapping the timers out from under a
// running engine makes the "does it actually animate" test below meaningless.

describe("SpeedGauge", () => {
  it("renders one channel for a directional stage", () => {
    const presentation = presentationFor({
      stageId: DOWNLOAD,
      stageProgress: { runId: RUN, entries: { [edgeKey(DOWNLOAD, 1)]: snapshot(DOWNLOAD, 1, 1_250_000) } },
    });
    render(<SpeedGauge presentation={presentation} ceiling={50} reducedMotion />);

    expect(screen.getAllByTestId(/^gauge-channel-/)).toHaveLength(1);
    expect(screen.getByText("You send")).toBeInTheDocument();
    expect(screen.getByTestId(`gauge-value-${edgeKey(DOWNLOAD, 1)}`).textContent).toBe("10.0");
  });

  it("renders two separately labelled duplex channels and never a total", () => {
    const presentation = presentationFor({
      stageId: DUPLEX,
      stageProgress: { runId: RUN, entries: {
        [edgeKey(DUPLEX, 0)]: snapshot(DUPLEX, 0, 1_250_000),
        [edgeKey(DUPLEX, 1)]: snapshot(DUPLEX, 1, 2_500_000),
      } },
    });
    render(<SpeedGauge presentation={presentation} ceiling={50} reducedMotion />);

    expect(screen.getAllByTestId(/^gauge-channel-/)).toHaveLength(2);
    expect(screen.getByText("You receive")).toBeInTheDocument();
    expect(screen.getByText("You send")).toBeInTheDocument();
    const values = screen.getAllByTestId(/^gauge-value-/).map((n) => n.textContent);
    expect(values).toEqual(["10.0", "20.0"]);
    // 30 (sum) and 15 (average) appear nowhere.
    expect(values).not.toContain("30.0");
    expect(values).not.toContain("15.0");
  });

  it("says measuring rather than 0 Mbps when there is no reading", () => {
    render(<SpeedGauge presentation={presentationFor({ stageId: UPLOAD })} ceiling={50} reducedMotion />);
    expect(screen.getByText("measuring…")).toBeInTheDocument();
    expect(screen.queryAllByTestId(/^gauge-value-/)).toEqual([]);
  });

  it("shows a genuine zero reading as a number", () => {
    const presentation = presentationFor({
      stageId: UPLOAD,
      stageProgress: { runId: RUN, entries: { [edgeKey(UPLOAD, 0)]: snapshot(UPLOAD, 0, 0) } },
    });
    render(<SpeedGauge presentation={presentation} ceiling={50} reducedMotion />);
    expect(screen.getByTestId(`gauge-value-${edgeKey(UPLOAD, 0)}`).textContent).toBe("0.00");
    expect(screen.queryByText("measuring…")).toBeNull();
  });

  it("distinguishes receive from send without colour", () => {
    const presentation = presentationFor({
      stageId: DUPLEX,
      stageProgress: { runId: RUN, entries: {
        [edgeKey(DUPLEX, 0)]: snapshot(DUPLEX, 0, 1_250_000),
        [edgeKey(DUPLEX, 1)]: snapshot(DUPLEX, 1, 1_250_000),
      } },
    });
    render(<SpeedGauge presentation={presentation} ceiling={50} reducedMotion />);

    const [receive, send] = screen.getAllByTestId(/^gauge-channel-/);
    expect(receive.getAttribute("data-role")).toBe("receive");
    expect(send.getAttribute("data-role")).toBe("send");
    // The send needle is dashed; the receive needle is not.
    expect(send.querySelector("line")?.getAttribute("stroke-dasharray")).toBe("4 3");
    expect(receive.querySelector("line")?.getAttribute("stroke-dasharray")).toBeNull();
    // Arrows carry the direction as well.
    expect(screen.getByText("←")).toBeInTheDocument();
    expect(screen.getByText("→")).toBeInTheDocument();
  });

  it("writes the final needle position synchronously under reduced motion", () => {
    const presentation = presentationFor({
      stageId: DOWNLOAD,
      stageProgress: { runId: RUN, entries: { [edgeKey(DOWNLOAD, 1)]: snapshot(DOWNLOAD, 1, 1_250_000) } },
    });
    render(<SpeedGauge presentation={presentation} ceiling={20} reducedMotion />);

    // 10 of 20 Mbps is half scale; no frames have run, so this must already
    // be correct rather than waiting for a tween.
    const needle = screen.getByTestId(`gauge-channel-${edgeKey(DOWNLOAD, 1)}`).querySelector("line");
    expect(needle?.getAttribute("transform")).toContain("rotate(-90");
  });

  it("shows the shared ceiling so the scale is legible", () => {
    render(<SpeedGauge presentation={presentationFor()} ceiling={500} reducedMotion />);
    expect(screen.getByText("500")).toBeInTheDocument();
  });
});

describe("RealtimeSpeedGraph", () => {
  it("draws one polyline per stage and edge, never joining stages", () => {
    const state = seriesFrom([
      presentationFor({ stageId: DOWNLOAD, stageProgress: { runId: RUN, entries: { [edgeKey(DOWNLOAD, 1)]: snapshot(DOWNLOAD, 1, 1_250_000) } } }),
      presentationFor({
        stageId: DOWNLOAD,
        stageProgress: { runId: RUN, entries: { [edgeKey(DOWNLOAD, 1)]: snapshot(DOWNLOAD, 1, 2_500_000, 2000) } },
      }),
      presentationFor({ stageId: UPLOAD, stageProgress: { runId: RUN, entries: { [edgeKey(UPLOAD, 0)]: snapshot(UPLOAD, 0, 1_250_000) } } }),
    ]);

    render(<RealtimeSpeedGraph state={state} reducedMotion />);

    const download = screen.getByTestId(`series-${edgeKey(DOWNLOAD, 1)}`);
    const upload = screen.getByTestId(`series-${edgeKey(UPLOAD, 0)}`);
    expect(download.getAttribute("points")!.split(" ")).toHaveLength(2);
    expect(upload.getAttribute("points")!.split(" ")).toHaveLength(1);
    // Separate polylines, so no diagonal ever joins the two stages.
    expect(download).not.toBe(upload);
  });

  it("overlays the stages from a common origin instead of stringing them out", () => {
    const state = seriesFrom([
      presentationFor({ stageId: DOWNLOAD, stageProgress: { runId: RUN, entries: { [edgeKey(DOWNLOAD, 1)]: snapshot(DOWNLOAD, 1, 1_250_000) } } }),
      presentationFor({
        stageId: DOWNLOAD,
        stageProgress: { runId: RUN, entries: { [edgeKey(DOWNLOAD, 1)]: snapshot(DOWNLOAD, 1, 2_500_000, 2000) } },
      }),
      // A much later stage: end-to-end layout would push this to the right
      // and leave most of the plot empty.
      presentationFor({ stageId: UPLOAD, stageProgress: { runId: RUN, entries: { [edgeKey(UPLOAD, 0)]: snapshot(UPLOAD, 0, 1_250_000) } } }),
    ]);
    render(<RealtimeSpeedGraph state={state} reducedMotion />);

    const firstX = (id: string) =>
      Number(screen.getByTestId(id).getAttribute("points")!.split(" ")[0].split(",")[0]);
    expect(firstX(`series-${edgeKey(DOWNLOAD, 1)}`)).toBe(firstX(`series-${edgeKey(UPLOAD, 0)}`));
    expect(screen.getByText("seconds into each stage")).toBeInTheDocument();
  });

  it("keeps duplex as two distinguishable traces", () => {
    const state = seriesFrom([
      presentationFor({
        stageId: DUPLEX,
        stageProgress: { runId: RUN, entries: {
          [edgeKey(DUPLEX, 0)]: snapshot(DUPLEX, 0, 1_250_000),
          [edgeKey(DUPLEX, 1)]: snapshot(DUPLEX, 1, 2_500_000),
        } },
      }),
    ]);
    render(<RealtimeSpeedGraph state={state} reducedMotion />);

    const receive = screen.getByTestId(`series-${edgeKey(DUPLEX, 0)}`);
    const send = screen.getByTestId(`series-${edgeKey(DUPLEX, 1)}`);
    expect(receive.getAttribute("stroke-dasharray")).toBeNull();
    expect(send.getAttribute("stroke-dasharray")).toBe("4 2.5");
    expect(screen.getByText(/Duplex · You receive/)).toBeInTheDocument();
    expect(screen.getByText(/Duplex · You send/)).toBeInTheDocument();
  });

  it("labels the axis with the shared monotonic ceiling", () => {
    const state = seriesFrom([
      presentationFor({
        stageId: DOWNLOAD,
        stageProgress: { runId: RUN, entries: { [edgeKey(DOWNLOAD, 1)]: snapshot(DOWNLOAD, 1, 11_250_000) } },
      }),
    ]);
    expect(state.ceiling).toBe(100);
    render(<RealtimeSpeedGraph state={state} reducedMotion />);
    // Axis ticks run 0, 25, 50, 75, 100 against the shared ceiling.
    for (const tick of ["0", "25", "50", "75", "100"]) {
      expect(screen.getByText(tick)).toBeInTheDocument();
    }
  });

  it("says it is waiting before the first reading", () => {
    render(<RealtimeSpeedGraph state={emptySpeedSeries()} reducedMotion />);
    expect(screen.getByText(/waiting for the first reading/)).toBeInTheDocument();
  });

  it("writes the readout synchronously under reduced motion", () => {
    const state = seriesFrom([
      presentationFor({ stageId: DOWNLOAD, stageProgress: { runId: RUN, entries: { [edgeKey(DOWNLOAD, 1)]: snapshot(DOWNLOAD, 1, 1_250_000) } } }),
    ]);
    render(<RealtimeSpeedGraph state={state} reducedMotion />);
    expect(screen.getByTestId(`readout-${edgeKey(DOWNLOAD, 1)}`).textContent).toBe("10.0");
  });
});

describe("Anime.js, driven by the real engine", () => {
  it("eases the needle towards a new value when motion is allowed", async () => {
    // Proves the tween is genuinely wired up, not merely that the
    // synchronous reduced-motion path works.
    const presentation = presentationFor({
      stageId: DOWNLOAD,
      stageProgress: { runId: RUN, entries: { [edgeKey(DOWNLOAD, 1)]: snapshot(DOWNLOAD, 1, 12_500_000) } },
    });
    render(<SpeedGauge presentation={presentation} ceiling={100} />);

    const needle = screen.getByTestId(`gauge-channel-${edgeKey(DOWNLOAD, 1)}`).querySelector("line")!;
    const start = needle.getAttribute("transform");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    expect(needle.getAttribute("transform")).not.toBe(start);
  });

  it("reverts cleanly on unmount", () => {
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
    expect(() => unmount()).not.toThrow();
  });
});
