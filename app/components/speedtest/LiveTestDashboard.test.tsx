import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IconType } from "react-icons";
import { BsArrows, BsThreeDots } from "react-icons/bs";
import { FaArrowLeftLong, FaArrowRightArrowLeft, FaArrowRightLong } from "react-icons/fa6";

import type { StageProgress } from "~/model/measurement.model";
import type { Slot } from "~/model/signaling.model";
import { DOWNLOAD, DUPLEX, UPLOAD, edgeKey, type StageId } from "~/model/stage.model";
import { selectLiveTestPresentation, selectStoredResultPresentation } from "~/lib/presentation-selector";
import type { LiveTestPresentation, LiveTestRoomView } from "~/model/presentation.model";

import LiveTestDashboard from "./LiveTestDashboard";
import type { GlobeDiagnostics, GlobeScene, GlobeSceneFactory } from "~/model/globe.model";

const RUN = "run-1";
// Shaped like a real lookup, which returns place fields alongside the
// coordinates — the marker keys off lat/lon, the text equivalent off the names.
const TOKYO = { lat: 35.6762, lon: 139.6503, city: "Tokyo", country: "Japan" };
const BERLIN = { lat: 52.52, lon: 13.405, city: "Berlin", country: "Germany" };
// What an iPad sends too: iPadOS Safari identifies itself as a Macintosh.
const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const WINDOWS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const UBUNTU_UA =
  "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0";

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

function snapshot(stageId: StageId, receiverSlot: Slot, bytes: number): StageProgress {
  return { stageId, receiverSlot, bytes, elapsedMs: 1000, chunksSeen: 100, highestSeqPlusOne: 100 };
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
    selfProfile: { name: "Ada", geo: TOKYO },
    otherProfile: { name: "Grace", geo: BERLIN },
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

/** The peer readout, which is the text equivalent of the globe's markers. */
function peerRegion(): HTMLElement {
  return screen.getByRole("region", { name: "Peers" });
}

/** The one line that holds a peer's name, address, place and glyphs. */
function peerLine(name: string | RegExp): HTMLElement {
  return within(peerRegion()).getByText(name).closest("aside")!;
}

/** The glyph between the two peer lines says which way the bytes are moving,
 * and says it only in pixels — so the test identifies it the way the eye
 * does, by shape. Rendering the icon in isolation keeps the expectation tied
 * to the component the dashboard imports rather than to a copied path. */
function shapeOf(Icon: IconType): string {
  const { container, unmount } = render(<Icon />);
  const shape = pathsOf(container.querySelector("svg")!);
  unmount();
  return shape;
}

function pathsOf(svg: SVGElement): string {
  return Array.from(svg.querySelectorAll("path"))
    .map((path) => path.getAttribute("d"))
    .join("|");
}

/** The direction glyph is the row's own child; the peers' device glyphs are
 * nested inside their `aside`s. */
function directionShape(): string {
  const row = peerRegion().querySelector("aside")!.parentElement!;
  return pathsOf(row.querySelector(":scope > svg")!);
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
    const region = peerRegion();
    expect(region.textContent).toContain("Ada (You)");
    expect(region.textContent).toContain("Tokyo, Japan");
    expect(region.textContent).toContain("Grace");
    expect(region.textContent).toContain("Berlin, Germany");
  });

  it("names the connection type once, above the pair", async () => {
    await renderDashboard(presentationFor({ connectionType: "RELAY" }));
    expect(within(peerRegion()).getByText("Relayed via TURN")).toBeInTheDocument();
  });

  it("names each peer's device from what that peer shared", async () => {
    await renderDashboard(
      presentationFor({
        selfProfile: { name: "Ada", geo: TOKYO, ua: MAC_UA, device: { type: "tablet", brand: "apple" } },
        otherProfile: { name: "Grace", geo: BERLIN, ua: WINDOWS_UA },
      }),
    );
    const region = peerRegion();
    // Ada said "iPad" outright; Grace said nothing but a UA, which is enough
    // to read a Windows desktop off.
    expect(within(region).getByRole("img", { name: "Apple tablet" })).toBeInTheDocument();
    expect(within(region).getByRole("img", { name: "Windows computer" })).toBeInTheDocument();
  });

  it("names a Linux peer by its distribution", async () => {
    await renderDashboard(
      presentationFor({ otherProfile: { name: "Grace", geo: BERLIN, ua: UBUNTU_UA } }),
    );
    expect(within(peerRegion()).getByRole("img", { name: "Ubuntu computer" })).toBeInTheDocument();
  });

  it("names no device for a peer that shared neither one nor a UA", async () => {
    await renderDashboard(
      presentationFor({ otherProfile: { name: "Grace", geo: BERLIN } }),
    );
    // Privacy On withholds the UA, so there is nothing to announce — and in
    // particular not the reader's own device, which is what a UA parser
    // handed nothing would answer.
    expect(within(peerRegion()).queryAllByRole("img")).toHaveLength(0);
  });

  it("shows each peer's address, and a dash where none was shared", async () => {
    await renderDashboard(
      presentationFor({
        selfProfile: { name: "Ada", geo: TOKYO, ip: "203.0.113.7", protocol: "IPv4" },
        otherProfile: { name: "Grace", geo: BERLIN },
      }),
    );
    expect(peerLine(/^Ada/).textContent).toContain("203.0.113.7");
    // A withheld address is an empty slot, never a plausible-looking guess.
    expect(peerLine("Grace").textContent).toContain("-");
  });

  it("says exactly whose location is unavailable", async () => {
    await renderDashboard(presentationFor({ otherProfile: { name: "Grace" } }));
    expect(peerLine("Grace").textContent).toContain("location not shared");
    // The peer who did share is unaffected.
    expect(peerLine(/^Ada/).textContent).toContain("Tokyo, Japan");
  });

  it("distinguishes 'not shared' from 'not received yet'", async () => {
    await renderDashboard(presentationFor({ otherProfile: null }));
    expect(screen.getByText(/location not received yet/)).toBeInTheDocument();
  });

  it("keeps the canvas decorative", async () => {
    await renderDashboard(presentationFor());
    const canvas = document.querySelector("canvas");
    expect(canvas).not.toBeNull();
    expect(canvas).toHaveAttribute("aria-hidden", "true");
  });
});

describe("LiveTestDashboard — the pair's direction glyph", () => {
  it("points along the stage that is running", async () => {
    // Global stage direction, not this browser's role: `download` is always
    // slot 0 -> slot 1, and the glyph is drawn from the stage name alone, so
    // both peers see the same arrow.
    for (const [stageId, Icon] of [
      [DOWNLOAD, FaArrowLeftLong],
      [UPLOAD, FaArrowRightLong],
      [DUPLEX, FaArrowRightArrowLeft],
    ] as const) {
      const expected = shapeOf(Icon);
      const { unmount } = await renderDashboard(presentationFor({ stageId }));
      expect(directionShape()).toBe(expected);
      unmount();
    }
  });

  it("falls back to a plain two-way glyph when no stage is running", async () => {
    const expected = shapeOf(BsArrows);
    for (const phase of ["paired", "result"] as const) {
      const { unmount } = await renderDashboard(presentationFor({ phase }));
      expect(directionShape()).toBe(expected);
      unmount();
    }
  });

  it("draws the three arrows apart from one another", async () => {
    // Colour and shape are the only distinction left once the direction is no
    // longer spelled out, so the three must not collapse into one glyph.
    const shapes = [FaArrowLeftLong, FaArrowRightLong, FaArrowRightArrowLeft, BsArrows].map(shapeOf);
    expect(new Set(shapes).size).toBe(shapes.length);
  });
});

describe("LiveTestDashboard — waiting for the other peer", () => {
  it("holds the second line open until the peer is really there", async () => {
    const expected = shapeOf(BsThreeDots);
    for (const phase of ["waiting", "pairing", "finalizing"] as const) {
      const { unmount } = await renderDashboard(presentationFor({ phase }));
      const region = peerRegion();
      expect(within(region).getByText("Waiting for peer...")).toBeInTheDocument();
      // Nothing about the other peer is drawn from a profile this phase has
      // not committed to yet.
      expect(within(region).queryByText("Grace")).toBeNull();
      expect(directionShape()).toBe(expected);
      unmount();
    }
  });

  it("still names this browser's own peer while it waits", async () => {
    await renderDashboard(presentationFor({ phase: "waiting" }));
    expect(peerLine(/^Ada/).textContent).toContain("Tokyo, Japan");
  });
});

describe("LiveTestDashboard — the detail panel", () => {
  const withDetails = () =>
    presentationFor({
      selfProfile: {
        name: "Ada",
        ua: MAC_UA,
        geo: { ...TOKYO, isp: "Sakura Internet", org: "Sakura", proxy: true },
      },
      otherProfile: { name: "Grace", geo: BERLIN },
    });

  it("keeps ISP and user agent folded away until the pair is tapped", async () => {
    await renderDashboard(withDetails());
    expect(screen.queryByText("User Agent")).toBeNull();
    expect(screen.queryByText(MAC_UA)).toBeNull();

    const row = peerRegion().querySelector("aside")!.parentElement!;
    fireEvent.click(row);

    expect(screen.getAllByText("User Agent").length).toBeGreaterThan(0);
    expect(screen.getByText(MAC_UA)).toBeInTheDocument();
    expect(screen.getByText("Sakura Internet · Sakura")).toBeInTheDocument();
    // Grace withheld both, so her column is a dash rather than Ada's values.
    expect(screen.getAllByText("-").length).toBeGreaterThan(0);

    fireEvent.click(row);
    expect(screen.queryByText("User Agent")).toBeNull();
  });

  it("spells out the network annotations that the line only draws", async () => {
    await renderDashboard(withDetails());
    fireEvent.click(peerRegion().querySelector("aside")!.parentElement!);
    // The shield glyph on the name line is unlabelled; this is where the word
    // for it lives.
    expect(screen.getAllByText("Proxy/VPN").length).toBeGreaterThan(0);
    // Absent annotations are not listed at all, rather than listed as false.
    expect(screen.queryByText("Cellular")).toBeNull();
    expect(screen.queryByText("Hosting")).toBeNull();
  });

  it("opens the same detail from a tap on a single peer", async () => {
    await renderDashboard(withDetails());
    fireEvent.click(peerLine(/^Ada/));
    expect(screen.getAllByText(MAC_UA).length).toBeGreaterThan(0);
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
        stageProgress: { runId: RUN, entries: { [edgeKey(DOWNLOAD, 1)]: snapshot(DOWNLOAD, 1, 1_250_000) } },
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
      expect(peerRegion()).toBeInTheDocument();
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
        stageProgress: { runId: RUN, entries: { [edgeKey(DOWNLOAD, 1)]: snapshot(DOWNLOAD, 1, 1_250_000) } },
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
        stageProgress: { runId: RUN, entries: { [edgeKey(DOWNLOAD, 1)]: snapshot(DOWNLOAD, 1, 1_250_000) } },
      }),
    );
    // Still there, still showing the number — it does not blank mid-sentence.
    expect(screen.getByTestId(`gauge-value-${edgeKey(DOWNLOAD, 1)}`).textContent).toBe("10.0");
  });

  it("keeps the globe and the run's trace beside the result, without a live gauge", async () => {
    const { rerender } = await renderDashboard(
      presentationFor({
        stageId: DOWNLOAD,
        stageProgress: { runId: RUN, entries: { [edgeKey(DOWNLOAD, 1)]: snapshot(DOWNLOAD, 1, 1_250_000) } },
      }),
    );
    rerender(
      <LiveTestDashboard presentation={presentationFor({ phase: "result" })} createScene={stubScene} />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId("speed-graph")).toBeInTheDocument();
    expect(peerRegion()).toBeInTheDocument();
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
    const region = peerRegion();
    expect(region.textContent).toContain("Ada (You)");
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
        stageProgress: { runId: RUN, entries: { [edgeKey(DOWNLOAD, 1)]: snapshot(DOWNLOAD, 1, 11_250_000) } },
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
          stageProgress: { runId: RUN, entries: { [edgeKey(UPLOAD, 0)]: snapshot(UPLOAD, 0, 125_000) } },
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
