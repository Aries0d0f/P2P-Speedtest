import { act, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StageProgressSnapshot } from "~/lib/control-channel";
import { DOWNLOAD, DUPLEX, UPLOAD, edgeKey, type Slot, type StageId } from "~/lib/stage";
import {
  selectLiveTestPresentation,
  selectStoredResultPresentation,
  type LiveTestPresentation,
  type LiveTestRoomView,
} from "~/lib/test-visualization";

import LiveTestDashboard from "./LiveTestDashboard";
import type { GlobeDiagnostics, GlobeScene, GlobeSceneFactory } from "./three/globe-scene";

const RUN = "run-1";
const TOKYO = { lat: 35.6762, lon: 139.6503 };
const BERLIN = { lat: 52.52, lon: 13.405 };

/** The globe is exercised in `PeerGlobe.test.tsx`; here it is a stub so the
 * dashboard's own composition and semantics are what is under test. */
const stubScene: GlobeSceneFactory = async () =>
  ({
    update: () => {},
    resize: () => {},
    setActive: () => {},
    diagnostics: () => ({}) as GlobeDiagnostics,
    dispose: () => {},
  }) satisfies GlobeScene;

function snapshot(stageId: StageId, receiverSlot: Slot, bytes: number): StageProgressSnapshot {
  return { stageId, receiverSlot, bytes, elapsedMs: 1000, chunksSeen: 100, highestSeqPlusOne: 100 };
}

function presentationFor(over: Partial<LiveTestRoomView> = {}, localSlot: Slot = 0): LiveTestPresentation {
  const view: LiveTestRoomView = {
    runId: RUN,
    phase: "testing",
    stageId: null,
    progressRunId: RUN,
    progress: {},
    liveLatency: null,
    latencyBaseline: undefined,
    connectionType: "DIRECT",
    localProfile: { name: "Ada", geo: TOKYO },
    remoteProfile: { name: "Grace", geo: BERLIN },
    ...over,
  };
  return selectLiveTestPresentation(view, localSlot);
}

async function renderDashboard(presentation: LiveTestPresentation) {
  const result = render(<LiveTestDashboard presentation={presentation} createScene={stubScene} />);
  await act(async () => {
    await Promise.resolve();
  });
  return result;
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ width: 900, height: 600, top: 0, left: 0, right: 900, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
  );
});

describe("LiveTestDashboard — semantics without the canvas", () => {
  it("names both peers and their shared locations", async () => {
    await renderDashboard(presentationFor());
    // Scoped to the semantic region: the globe's own overlay labels are
    // `aria-hidden` decoration and must not be what a reader relies on.
    const region = screen.getByRole("region", { name: "Peers and locations" });
    expect(region.textContent).toContain("Ada (you)");
    expect(region.textContent).toContain("35.68, 139.65");
    expect(region.textContent).toContain("Grace");
    expect(region.textContent).toContain("52.52, 13.40");
  });

  it("says exactly whose location is unavailable", async () => {
    await renderDashboard(presentationFor({ remoteProfile: { name: "Grace" } }));
    const region = screen.getByRole("region", { name: "Peers and locations" });
    const graceLine = within(region).getByText("Grace").closest("p")!;
    expect(graceLine.textContent).toContain("location not shared");
    // The peer who did share is unaffected.
    expect(region.textContent).toContain("35.68, 139.65");
  });

  it("distinguishes 'not shared' from 'not received yet'", async () => {
    await renderDashboard(presentationFor({ remoteProfile: null }));
    expect(screen.getByText(/location not received yet/)).toBeInTheDocument();
  });

  it("spells out the transfer direction as text", async () => {
    await renderDashboard(
      presentationFor({
        stageId: DOWNLOAD,
        progress: { [edgeKey(DOWNLOAD, 1)]: snapshot(DOWNLOAD, 1, 1_250_000) },
      }),
    );
    // Slot 0 sends during download: Ada → Grace, on both peers' screens.
    expect(screen.getByText(/Ada → Grace/)).toBeInTheDocument();
    expect(screen.getByText(/you send/)).toBeInTheDocument();
  });

  it("shows both duplex directions separately", async () => {
    await renderDashboard(
      presentationFor({
        stageId: DUPLEX,
        progress: {
          [edgeKey(DUPLEX, 0)]: snapshot(DUPLEX, 0, 1_250_000),
          [edgeKey(DUPLEX, 1)]: snapshot(DUPLEX, 1, 2_500_000),
        },
      }),
    );
    expect(screen.getByText(/Grace → Ada/)).toBeInTheDocument();
    expect(screen.getByText(/Ada → Grace/)).toBeInTheDocument();
  });

  it("keeps the canvas decorative", async () => {
    await renderDashboard(presentationFor());
    const canvas = document.querySelector("canvas");
    expect(canvas).not.toBeNull();
    expect(canvas).toHaveAttribute("aria-hidden", "true");
  });
});

describe("LiveTestDashboard — announcements", () => {
  it("announces stage changes politely", async () => {
    const { rerender } = await renderDashboard(presentationFor({ stageId: DOWNLOAD }));
    const region = screen.getByTestId("stage-announcement");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region.textContent).toBe("Measuring download");

    rerender(
      <LiveTestDashboard presentation={presentationFor({ stageId: UPLOAD })} createScene={stubScene} />,
    );
    expect(screen.getByTestId("stage-announcement").textContent).toBe("Measuring upload");
  });

  it("does not put four-per-second speed updates in a live region", async () => {
    await renderDashboard(
      presentationFor({
        stageId: DOWNLOAD,
        progress: { [edgeKey(DOWNLOAD, 1)]: snapshot(DOWNLOAD, 1, 1_250_000) },
      }),
    );
    const live = document.querySelectorAll("[aria-live]");
    for (const node of live) {
      expect(node.textContent).not.toMatch(/Mbps/);
    }
  });
});

describe("LiveTestDashboard — panels follow the presentation", () => {
  it("shows the globe alone before the test starts", async () => {
    for (const phase of ["waiting", "pairing", "paired"] as const) {
      const { unmount } = await renderDashboard(presentationFor({ phase }));
      expect(document.querySelector("canvas")).not.toBeNull();
      expect(screen.getByRole("region", { name: "Peers and locations" })).toBeInTheDocument();
      // No readings yet, so an empty graph and a dead gauge would be furniture.
      expect(screen.queryByTestId("speed-graph")).toBeNull();
      expect(screen.queryByTestId("speed-gauge")).toBeNull();
      unmount();
    }
  });

  it("shows all three panels during a stage", async () => {
    await renderDashboard(
      presentationFor({
        stageId: DOWNLOAD,
        progress: { [edgeKey(DOWNLOAD, 1)]: snapshot(DOWNLOAD, 1, 1_250_000) },
      }),
    );
    expect(document.querySelector("canvas")).not.toBeNull();
    expect(screen.getByTestId("speed-graph")).toBeInTheDocument();
    expect(screen.getByTestId("speed-gauge")).toBeInTheDocument();
  });

  it("keeps the gauge frozen on its last reading while finalizing", async () => {
    await renderDashboard(
      presentationFor({
        phase: "finalizing",
        stageId: DOWNLOAD,
        progress: { [edgeKey(DOWNLOAD, 1)]: snapshot(DOWNLOAD, 1, 1_250_000) },
      }),
    );
    // Still there, still showing the number — it does not blank mid-sentence.
    expect(screen.getByTestId(`gauge-value-${edgeKey(DOWNLOAD, 1)}`).textContent).toBe("10.0");
  });

  it("keeps the globe and the run's trace beside the result, without a live gauge", async () => {
    const { rerender } = await renderDashboard(
      presentationFor({
        stageId: DOWNLOAD,
        progress: { [edgeKey(DOWNLOAD, 1)]: snapshot(DOWNLOAD, 1, 1_250_000) },
      }),
    );
    rerender(
      <LiveTestDashboard presentation={presentationFor({ phase: "result" })} createScene={stubScene} />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId("speed-graph")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Peers and locations" })).toBeInTheDocument();
    // The run is over; a live gauge would claim a transfer that has stopped.
    expect(screen.queryByTestId("speed-gauge")).toBeNull();
  });

  it("renders a stored result's globe with no graph or gauge at all", async () => {
    const presentation = selectStoredResultPresentation({
      runId: "room-1:peer-a",
      peers: [
        { id: "peer-a", name: "Ada", geo: TOKYO },
        { id: "peer-b", name: "Grace", geo: BERLIN },
      ],
      localPeerId: "peer-a",
      connectionType: "DIRECT",
    });
    await renderDashboard(presentation);

    expect(document.querySelector("canvas")).not.toBeNull();
    const region = screen.getByRole("region", { name: "Peers and locations" });
    expect(region.textContent).toContain("Ada (you)");
    expect(region.textContent).toContain("Grace");
    expect(screen.queryByTestId("speed-graph")).toBeNull();
    expect(screen.queryByTestId("speed-gauge")).toBeNull();
  });
});

describe("LiveTestDashboard — shared scale", () => {
  it("feeds the graph and gauge from the same monotonic ceiling", async () => {
    const { rerender } = await renderDashboard(
      presentationFor({
        stageId: DOWNLOAD,
        progress: { [edgeKey(DOWNLOAD, 1)]: snapshot(DOWNLOAD, 1, 11_250_000) },
      }),
    );
    // 90 Mbps rounds the shared ceiling up to 100; the gauge prints it as
    // its full-scale end cap and the graph as its top axis tick.
    expect(within(screen.getByTestId("speed-gauge")).getByText("100")).toBeInTheDocument();
    expect(within(screen.getByTestId("speed-graph")).getByText("100")).toBeInTheDocument();

    // A later, slower stage must not shrink the axis.
    rerender(
      <LiveTestDashboard
        presentation={presentationFor({
          stageId: UPLOAD,
          progress: { [edgeKey(UPLOAD, 0)]: snapshot(UPLOAD, 0, 125_000) },
        })}
        createScene={stubScene}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(within(screen.getByTestId("speed-gauge")).getByText("100")).toBeInTheDocument();
    expect(within(screen.getByTestId("speed-graph")).getByText("100")).toBeInTheDocument();
  });
});
