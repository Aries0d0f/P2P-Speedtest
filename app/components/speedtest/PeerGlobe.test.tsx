import { StrictMode } from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Slot } from "~/model/signaling.model";
import { DOWNLOAD, DUPLEX, UPLOAD, edgeKey, type StageId } from "~/model/stage.model";
import { selectLiveTestPresentation } from "~/lib/presentation-selector";
import type { LiveTestPresentation, LiveTestRoomView } from "~/model/presentation.model";
import type { StageProgress } from "~/model/measurement.model";

import { PeerGlobe } from "./PeerGlobe";
import { buildFrame } from "~/lib/globe-frame";
import type { GlobeDiagnostics, GlobeFrame, GlobeScene, GlobeSceneFactory, GlobeSceneOptions, LabelPlacement } from "~/model/globe.model";

const RUN = "run-1";
const TOKYO = { lat: 35.6762, lon: 139.6503 };
const BERLIN = { lat: 52.52, lon: 13.405 };

function snapshot(stageId: StageId, receiverSlot: Slot, bytes = 1_250_000): StageProgress {
  return { stageId, receiverSlot, bytes, elapsedMs: 1000, chunksSeen: 100, highestSeqPlusOne: 100 };
}

function presentationFor(
  over: Partial<LiveTestRoomView> = {},
  localSlot: Slot = 0,
): LiveTestPresentation {
  const view: LiveTestRoomView = {
    runId: RUN,
    phase: "testing",
    stageId: null,
    stageProgress: { runId: RUN, entries: {} },
    liveLatency: null,
    latencyBaseline: undefined,
    connectionType: "DIRECT",
    selfProfile: { name: "Local", geo: TOKYO },
    otherProfile: { name: "Remote", geo: BERLIN },
    ...over,
  };
  return selectLiveTestPresentation(view, localSlot);
}

/** A scene double that records everything React asks of it. The real
 * Three.js scene never runs in jsdom; what these tests pin is the lifecycle
 * contract around it. */
interface FakeScene extends GlobeScene {
  readonly frames: GlobeFrame[];
  /** `[canvasWidth, canvasHeight, referenceHeight]` */
  readonly resizes: Array<[number, number, number]>;
  readonly activeCalls: boolean[];
  disposals: number;
  options: GlobeSceneOptions;
}

const created: FakeScene[] = [];
let createCount = 0;

function makeFactory(behaviour?: { fail?: unknown; defer?: boolean }): {
  factory: GlobeSceneFactory;
  resolveAll: () => void;
} {
  const pending: Array<() => void> = [];
  const factory: GlobeSceneFactory = (options) => {
    createCount++;
    if (behaviour?.fail !== undefined) return Promise.reject(behaviour.fail);

    const scene: FakeScene = {
      frames: [],
      resizes: [],
      activeCalls: [],
      disposals: 0,
      options,
      update(frame) {
        scene.frames.push(frame);
      },
      resize(w, h, referenceHeight) {
        scene.resizes.push([w, h, referenceHeight]);
      },
      setActive(a) {
        scene.activeCalls.push(a);
      },
      diagnostics: () => ({}) as GlobeDiagnostics,
      dispose() {
        scene.disposals++;
      },
    };
    created.push(scene);
    if (!behaviour?.defer) return Promise.resolve(scene);
    return new Promise((resolve) => pending.push(() => resolve(scene)));
  };
  return { factory, resolveAll: () => pending.splice(0).forEach((r) => r()) };
}

/**
 * jsdom reports every element as 0x0, so the component would never create a
 * scene. Two boxes are stubbed, deliberately different: the fixed layer is
 * the viewport, the in-flow placeholder is the smaller box the globe used to
 * occupy. Anything that conflates the two shows up as a wrong number here.
 */
const VIEWPORT = { width: 1440, height: 900 };
const PLACEHOLDER = { width: 768, height: 576 };

function stubLayout(placeholder = PLACEHOLDER, viewport = VIEWPORT) {
  const rect = ({ width, height }: { width: number; height: number }) =>
    ({ width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return rect(this.dataset.testid === "peer-globe-layer" ? viewport : placeholder);
  });
}

beforeEach(() => {
  created.length = 0;
  createCount = 0;
  stubLayout();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("PeerGlobe — scene lifecycle", () => {
  it("creates exactly one scene and hands it the first frame", async () => {
    const { factory } = makeFactory();
    render(<PeerGlobe presentation={presentationFor()} createScene={factory} />);
    await flush();

    expect(createCount).toBe(1);
    // The canvas gets the viewport; the globe's scale keeps the placeholder's
    // height, so filling the screen never magnifies the globe.
    expect(created[0].resizes).toEqual([[1440, 900, 576]]);
    expect(created[0].frames).toHaveLength(1);
    // Orientation still keys off the page's own responsive box, not the
    // viewport the canvas happens to cover.
    expect(created[0].frames[0].layout).toBe("desktop");
  });

  it("keys the layout off the placeholder, not the viewport", async () => {
    // A phone-width placeholder inside a wide window must still get the
    // mobile self-left/peer-right contract.
    stubLayout({ width: 420, height: 420 }, { width: 1440, height: 900 });
    const { factory } = makeFactory();
    render(<PeerGlobe presentation={presentationFor()} createScene={factory} />);
    await flush();
    expect(created[0].frames[0].layout).toBe("mobile");
    expect(created[0].resizes).toEqual([[1440, 900, 420]]);
  });

  it("reserves the globe's layout space and puts the canvas in a fixed layer", async () => {
    const { factory } = makeFactory();
    render(<PeerGlobe presentation={presentationFor()} createScene={factory} />);
    await flush();

    const placeholder = screen.getByTestId("peer-globe");
    const layer = screen.getByTestId("peer-globe-layer");
    // The placeholder holds the space the out-of-flow canvas vacated.
    expect(placeholder.className).toContain("aspect-square");
    expect(placeholder.querySelector("canvas")).toBeNull();
    // The layer is fixed and never eats a click meant for the Cancel button.
    expect(layer.className).toContain("fixed");
    expect(layer.className).toContain("pointer-events-none");
    expect(layer.querySelector("canvas")).not.toBeNull();
    // It carries no z-index at all: document order is what puts the page on
    // top of it, and a negative z-index would sink it behind body's own
    // background and make it invisible.
    expect(layer.className).not.toMatch(/z-/);
  });

  it("portals the layer to the front of the document", async () => {
    const { factory } = makeFactory();
    render(<PeerGlobe presentation={presentationFor()} createScene={factory} />);
    await flush();

    const layer = screen.getByTestId("peer-globe-layer");
    // First child of <body>, so every positioned element in the app — all of
    // which come later in document order — paints over it.
    expect(document.body.firstElementChild).toHaveAttribute("data-globe-layer-host");
    expect(document.body.firstElementChild!.contains(layer)).toBe(true);
  });

  it("removes the portal host on unmount", async () => {
    const { factory } = makeFactory();
    const { unmount } = render(<PeerGlobe presentation={presentationFor()} createScene={factory} />);
    await flush();
    expect(document.querySelector("[data-globe-layer-host]")).not.toBeNull();
    unmount();
    expect(document.querySelector("[data-globe-layer-host]")).toBeNull();
  });

  it("disposes the scene on unmount", async () => {
    const { factory } = makeFactory();
    const { unmount } = render(<PeerGlobe presentation={presentationFor()} createScene={factory} />);
    await flush();
    unmount();
    expect(created[0].disposals).toBe(1);
  });

  it("leaves no undisposed scene after a StrictMode mount/unmount/remount", async () => {
    const { factory } = makeFactory();
    const { unmount } = render(
      <StrictMode>
        <PeerGlobe presentation={presentationFor()} createScene={factory} />
      </StrictMode>,
    );
    await flush();
    unmount();
    await flush();

    // Whatever StrictMode created, every one of them is disposed: no leaked
    // WebGL context survives the double-invoke.
    expect(created.length).toBeGreaterThan(0);
    for (const scene of created) expect(scene.disposals).toBeGreaterThanOrEqual(1);
  });

  it("disposes a scene that resolves after unmount", async () => {
    const { factory, resolveAll } = makeFactory({ defer: true });
    const { unmount } = render(<PeerGlobe presentation={presentationFor()} createScene={factory} />);
    await flush();
    unmount();
    await act(async () => {
      resolveAll();
      await Promise.resolve();
    });
    expect(created[0].disposals).toBe(1);
  });

  it("never creates a scene before the container has been measured", async () => {
    stubLayout({ width: 0, height: 0 }, { width: 0, height: 0 });
    const { factory } = makeFactory();
    render(<PeerGlobe presentation={presentationFor()} createScene={factory} />);
    await flush();
    expect(createCount).toBe(0);
  });
});

describe("PeerGlobe — frames", () => {
  it("maps a directional stage to one stream in the physical direction", async () => {
    const { factory } = makeFactory();
    // Slot 0 during download is the sender, so packets leave the local marker.
    const { rerender } = render(
      <PeerGlobe
        presentation={presentationFor({ stageId: DOWNLOAD, stageProgress: { runId: RUN, entries: { [edgeKey(DOWNLOAD, 1)]: snapshot(DOWNLOAD, 1) } } }, 0)}
        createScene={factory}
      />,
    );
    await flush();
    const sender = created[0].frames.at(-1)!;
    expect(sender.streams).toHaveLength(1);
    expect(sender.streams[0].fromLocal).toBe(true);
    expect(sender.running).toBe(true);

    // The receiving peer sees the same physical direction: into its marker.
    rerender(
      <PeerGlobe
        presentation={presentationFor({ stageId: DOWNLOAD, stageProgress: { runId: RUN, entries: { [edgeKey(DOWNLOAD, 1)]: snapshot(DOWNLOAD, 1) } } }, 1)}
        createScene={factory}
      />,
    );
    await flush();
    const receiver = created[0].frames.at(-1)!;
    expect(receiver.streams[0].fromLocal).toBe(false);
    // ...but the local colour differs, which is the local-view contract.
    expect(receiver.streams[0].color).not.toBe(sender.streams[0].color);
  });

  it("gives duplex two opposing streams", async () => {
    const { factory } = makeFactory();
    render(
      <PeerGlobe
        presentation={presentationFor(
          {
            stageId: DUPLEX,
            stageProgress: { runId: RUN, entries: {
              [edgeKey(DUPLEX, 0)]: snapshot(DUPLEX, 0),
              [edgeKey(DUPLEX, 1)]: snapshot(DUPLEX, 1, 2_500_000),
            } },
          },
          0,
        )}
        createScene={factory}
      />,
    );
    await flush();
    const frame = created[0].frames.at(-1)!;
    expect(frame.streams).toHaveLength(2);
    expect(frame.streams.map((s) => s.fromLocal)).toEqual([false, true]);
    expect(frame.streams[0].color).toBe(frame.streams[1].color);
    // Two independent readings, never combined.
    expect(frame.streams.map((s) => s.mbps)).toEqual([10, 20]);
  });

  it("stops the flow when no stage is running", async () => {
    const { factory } = makeFactory();
    render(<PeerGlobe presentation={presentationFor({ stageId: null })} createScene={factory} />);
    await flush();
    const frame = created[0].frames.at(-1)!;
    expect(frame.running).toBe(false);
    expect(frame.streams).toEqual([]);
  });

  it("stops the flow while finalizing", async () => {
    const { factory } = makeFactory();
    render(
      <PeerGlobe presentation={presentationFor({ stageId: UPLOAD, phase: "finalizing" })} createScene={factory} />,
    );
    await flush();
    expect(created[0].frames.at(-1)!.running).toBe(false);
  });

  it("adds a marker when geo enrichment arrives late", async () => {
    const { factory } = makeFactory();
    const { rerender } = render(
      <PeerGlobe
        presentation={presentationFor({ stageId: DOWNLOAD, otherProfile: { name: "Remote" } })}
        createScene={factory}
      />,
    );
    await flush();
    expect(created[0].frames.at(-1)!.remoteLocation).toBeNull();

    rerender(
      <PeerGlobe
        presentation={presentationFor({ stageId: DOWNLOAD, otherProfile: { name: "Remote", geo: BERLIN } })}
        createScene={factory}
      />,
    );
    await flush();
    expect(created[0].frames.at(-1)!.remoteLocation).toEqual(BERLIN);
    // The same scene handled it: no rebuild, and therefore no interruption.
    expect(createCount).toBe(1);
  });

  it("invents nothing when neither peer shared a location", async () => {
    const { factory } = makeFactory();
    render(
      <PeerGlobe
        presentation={presentationFor({ selfProfile: { name: "A" }, otherProfile: { name: "B" } })}
        createScene={factory}
      />,
    );
    await flush();
    const frame = created[0].frames.at(-1)!;
    expect(frame.localLocation).toBeNull();
    expect(frame.remoteLocation).toBeNull();
    // No label is rendered for a peer with no marker.
    expect(screen.queryByText("A (You)")).toBeNull();
  });
});

describe("PeerGlobe — layout and lifecycle signals", () => {
  it("uses the measured container width, not a user-agent string", () => {
    const presentation = presentationFor();
    expect(buildFrame(presentation, 900, false, null).layout).toBe("desktop");
    expect(buildFrame(presentation, 420, false, null).layout).toBe("mobile");
    expect(buildFrame(presentation, 768, false, null).layout).toBe("desktop");
    expect(buildFrame(presentation, 767, false, null).layout).toBe("mobile");
  });

  it("passes reduced motion through to the frame", () => {
    expect(buildFrame(presentationFor(), 900, true, null).reducedMotion).toBe(true);
  });

  it("pauses the scene while the document is hidden and resumes on return", async () => {
    const { factory } = makeFactory();
    render(<PeerGlobe presentation={presentationFor()} createScene={factory} />);
    await flush();
    created[0].activeCalls.length = 0;

    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(created[0].activeCalls.at(-1)).toBe(false);

    hidden.mockReturnValue(false);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(created[0].activeCalls.at(-1)).toBe(true);
  });
});

describe("PeerGlobe — failure isolation", () => {
  it("shows a local fallback when the scene factory rejects", async () => {
    const onVisualError = vi.fn();
    const { factory } = makeFactory({ fail: new Error("no webgl") });
    render(
      <PeerGlobe presentation={presentationFor()} createScene={factory} onVisualError={onVisualError} />,
    );
    await flush();

    expect(screen.getByText(/globe couldn't be shown/i)).toBeInTheDocument();
    expect(onVisualError).toHaveBeenCalledTimes(1);
  });

  it("shows the fallback when the scene reports an imperative error after mount", async () => {
    const onVisualError = vi.fn();
    const { factory } = makeFactory();
    render(
      <PeerGlobe presentation={presentationFor()} createScene={factory} onVisualError={onVisualError} />,
    );
    await flush();

    // What a lost context or a throw inside RAF looks like from React's side:
    // an error boundary cannot see it, so the scene calls back.
    await act(async () => {
      created[0].options.onError(new Error("context lost"));
    });

    expect(screen.getByText(/globe couldn't be shown/i)).toBeInTheDocument();
    expect(onVisualError).toHaveBeenCalledTimes(1);
    expect(created[0].disposals).toBe(1);
  });

  it("reports a failure once per run, then clears on a new run", async () => {
    const onVisualError = vi.fn();
    const { factory } = makeFactory();
    const { rerender } = render(
      <PeerGlobe presentation={presentationFor()} createScene={factory} onVisualError={onVisualError} />,
    );
    await flush();

    await act(async () => {
      created[0].options.onError(new Error("first"));
      created[0].options.onError(new Error("second"));
    });
    expect(onVisualError).toHaveBeenCalledTimes(1);

    rerender(
      <PeerGlobe
        presentation={presentationFor({ runId: "run-2", stageProgress: { runId: "run-2", entries: {} }})}
        createScene={factory}
        onVisualError={onVisualError}
      />,
    );
    await flush();
    expect(screen.queryByText(/globe couldn't be shown/i)).toBeNull();
    expect(createCount).toBe(2);
  });

  it("does not retry within the same run", async () => {
    const { factory } = makeFactory({ fail: new Error("no webgl") });
    const { rerender } = render(<PeerGlobe presentation={presentationFor()} createScene={factory} />);
    await flush();
    rerender(<PeerGlobe presentation={presentationFor({ stageId: DOWNLOAD })} createScene={factory} />);
    await flush();
    expect(createCount).toBe(1);
  });
});

describe("PeerGlobe — labels take opposite sides", () => {
  const AT = (x: number, visible = true) => ({ x, y: 200, visible });

  /** Renders both markers, then drives one frame of label placement. */
  async function withLabels() {
    const { factory } = makeFactory();
    render(<PeerGlobe presentation={presentationFor()} createScene={factory} />);
    await flush();
    const send = async (local: LabelPlacement | null, remote: LabelPlacement | null) => {
      await act(async () => created[0].options.onLabels({ local, remote }));
    };
    const local = () => screen.getByText("Local (You)").parentElement!;
    const remote = () => screen.getByText("Remote").parentElement!;
    return { send, local, remote };
  }

  it("hangs each label away from the other marker", async () => {
    const { send, local, remote } = await withLabels();
    // Local projects to the left of remote, so its label ends at its marker
    // and remote's starts at its own — the pair opens outward.
    await send(AT(300), AT(900));
    expect(local().className).toContain("text-right");
    expect(local().style.transform).toBe(
      "translate(300px, 200px) translate(calc(-100% - 8px), -140%)",
    );
    expect(remote().className).toContain("text-left");
    expect(remote().style.transform).toBe("translate(900px, 200px) translate(8px, -140%)");
  });

  it("swaps both sides when the markers cross", async () => {
    const { send, local, remote } = await withLabels();
    await send(AT(300), AT(900));
    await send(AT(900), AT(300));
    expect(local().className).toContain("text-left");
    expect(remote().className).toContain("text-right");
    // Never the same side: that is the overlap the flip exists to prevent.
    expect(local().style.transform).toBe("translate(900px, 200px) translate(8px, -140%)");
    expect(remote().style.transform).toBe(
      "translate(300px, 200px) translate(calc(-100% - 8px), -140%)",
    );
  });

  it("holds its sides while the markers pass within the flip margin", async () => {
    const { send, local } = await withLabels();
    await send(AT(300), AT(900));
    // 16px apart and now on the wrong side of each other, but inside the
    // margin — flipping here is the flicker the band exists to stop.
    await send(AT(608), AT(592));
    expect(local().className).toContain("text-right");
    await send(AT(700), AT(500));
    expect(local().className).toContain("text-left");
  });

  it("leaves the sides alone while a marker is behind the globe", async () => {
    const { send, local, remote } = await withLabels();
    await send(AT(300), AT(900));
    await send(AT(300), AT(100, false));
    expect(local().className).toContain("text-right");
    // A hidden marker's label is not merely off-side, it is not drawn.
    expect(remote().style.display).toBe("none");
  });
});
