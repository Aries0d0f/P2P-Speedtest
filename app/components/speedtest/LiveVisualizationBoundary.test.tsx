import { Suspense, lazy, useEffect } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LiveVisualizationBoundary,
  VisualizationPending,
} from "./LiveVisualizationBoundary";

/**
 * Failure isolation (06-live-test-visualization 6.5).
 *
 * Every test here mounts a stand-in for the room: a core panel carrying the
 * metrics, stage, connection badge and Cancel button, and — as a *sibling*,
 * never a descendant — the optional visualization inside its boundary. The
 * assertion that matters in all of them is the same: whatever the enhancement
 * does, the core panel is still there and Cancel still works.
 */

let cancelled = 0;

function CoreTestPanel() {
  return (
    <section data-testid="core-panel">
      <p data-testid="connection-badge">Direct Connection</p>
      <p data-testid="stage-status">Measuring download…</p>
      <p data-testid="metric-rtt">RTT 24 ms · jitter 1.4 ms</p>
      <p data-testid="metric-speed">You receiving: 94.2 Mbps · loss 0.0%</p>
      <button type="button" onClick={() => cancelled++}>
        Cancel
      </button>
    </section>
  );
}

function expectCorePanelIntact() {
  expect(screen.getByTestId("core-panel")).toBeInTheDocument();
  expect(screen.getByTestId("connection-badge")).toBeInTheDocument();
  expect(screen.getByTestId("stage-status")).toBeInTheDocument();
  expect(screen.getByTestId("metric-rtt")).toBeInTheDocument();
  expect(screen.getByTestId("metric-speed")).toBeInTheDocument();

  const before = cancelled;
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(cancelled).toBe(before + 1);
}

/** The room's shape: core panel first and outside, enhancement second. */
function Room({
  children,
  resetKey = "run-1",
  failed = false,
  onError,
}: {
  children: React.ReactNode;
  resetKey?: string | null;
  failed?: boolean;
  onError?: (error: unknown) => void;
}) {
  return (
    <main>
      <CoreTestPanel />
      <LiveVisualizationBoundary resetKey={resetKey} failed={failed} onError={onError}>
        {children}
      </LiveVisualizationBoundary>
    </main>
  );
}

beforeEach(() => {
  cancelled = 0;
  // React logs caught boundary errors; keep the suite output readable while
  // still letting an unexpected console error surface in a debug run.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LiveVisualizationBoundary", () => {
  it("renders its children when nothing has failed", () => {
    render(
      <Room>
        <p data-testid="live-test-dashboard">globe</p>
      </Room>,
    );
    expect(screen.getByTestId("live-test-dashboard")).toBeInTheDocument();
    expect(screen.queryByTestId("visualization-unavailable")).toBeNull();
    expectCorePanelIntact();
  });

  it("replaces only the enhancement when a child throws during render", () => {
    const onError = vi.fn();
    function Exploding(): React.ReactElement {
      throw new Error("bad geometry");
    }

    render(
      <Room onError={onError}>
        <Exploding />
      </Room>,
    );

    expect(screen.getByTestId("visualization-unavailable")).toBeInTheDocument();
    expect(screen.queryByTestId("live-test-dashboard")).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expectCorePanelIntact();
  });

  it("replaces only the enhancement when a child throws in an effect", () => {
    const onError = vi.fn();
    function ExplodingEffect(): React.ReactElement {
      // A commit-phase throw, which a boundary *can* see — unlike a throw
      // from inside `requestAnimationFrame`, covered by `failed` below.
      useEffect(() => {
        throw new Error("effect blew up");
      }, []);
      return <p data-testid="live-test-dashboard">globe</p>;
    }

    render(
      <Room onError={onError}>
        <ExplodingEffect />
      </Room>,
    );
    expect(screen.getByTestId("visualization-unavailable")).toBeInTheDocument();
    expect(screen.queryByTestId("live-test-dashboard")).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expectCorePanelIntact();
  });

  it("replaces only the enhancement when the lazy chunk rejects", async () => {
    const Rejecting = lazy(() => Promise.reject(new Error("chunk 404")));
    const onError = vi.fn();

    render(
      <Room onError={onError}>
        <Suspense fallback={<VisualizationPending />}>
          <Rejecting />
        </Suspense>
      </Room>,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId("visualization-unavailable")).toBeInTheDocument();
    expect(screen.queryByTestId("visualization-pending")).toBeNull();
    expect(onError).toHaveBeenCalled();
    expectCorePanelIntact();
  });

  it("shows a pending state, not a failure, while the chunk loads", () => {
    let resolve: (value: { default: () => React.ReactElement }) => void = () => {};
    const Pending = lazy(() => new Promise<{ default: () => React.ReactElement }>((r) => (resolve = r)));

    render(
      <Room>
        <Suspense fallback={<VisualizationPending />}>
          <Pending />
        </Suspense>
      </Room>,
    );

    expect(screen.getByTestId("visualization-pending")).toBeInTheDocument();
    expect(screen.queryByTestId("visualization-unavailable")).toBeNull();
    expectCorePanelIntact();
    resolve({ default: () => <p>ok</p> });
  });

  it("shows the fallback for an imperative failure reported after mount", () => {
    // A throw inside `requestAnimationFrame` or an Anime.js callback never
    // reaches a React boundary; the owner reports it and the room flips
    // `failed`.
    const { rerender } = render(
      <Room failed={false}>
        <p data-testid="live-test-dashboard">globe</p>
      </Room>,
    );
    expect(screen.getByTestId("live-test-dashboard")).toBeInTheDocument();

    rerender(
      <Room failed>
        <p data-testid="live-test-dashboard">globe</p>
      </Room>,
    );
    expect(screen.getByTestId("visualization-unavailable")).toBeInTheDocument();
    expectCorePanelIntact();
  });

  it("stays failed for the rest of the run", () => {
    const onError = vi.fn();
    let shouldThrow = true;
    function Flaky(): React.ReactElement {
      if (shouldThrow) throw new Error("once");
      return <p data-testid="live-test-dashboard">globe</p>;
    }

    const { rerender } = render(
      <Room onError={onError}>
        <Flaky />
      </Room>,
    );
    expect(screen.getByTestId("visualization-unavailable")).toBeInTheDocument();

    // Even once the child would succeed, the same run does not retry — a
    // broken driver must not be re-probed four times a second.
    shouldThrow = false;
    rerender(
      <Room onError={onError}>
        <Flaky />
      </Room>,
    );
    expect(screen.getByTestId("visualization-unavailable")).toBeInTheDocument();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("clears the failure when a new run starts", () => {
    let shouldThrow = true;
    function Flaky(): React.ReactElement {
      if (shouldThrow) throw new Error("once");
      return <p data-testid="live-test-dashboard">globe</p>;
    }

    const { rerender } = render(
      <Room resetKey="run-1">
        <Flaky />
      </Room>,
    );
    expect(screen.getByTestId("visualization-unavailable")).toBeInTheDocument();

    shouldThrow = false;
    rerender(
      <Room resetKey="run-2">
        <Flaky />
      </Room>,
    );
    expect(screen.getByTestId("live-test-dashboard")).toBeInTheDocument();
  });

  it("dispatches no room action for any visual failure", () => {
    // The boundary's only outward call is `onError`. If a future edit added a
    // reducer dispatch, this fake room would see it.
    const dispatch = vi.fn();
    const onError = vi.fn();
    function Exploding(): React.ReactElement {
      throw new Error("bad geometry");
    }

    render(
      <div onClick={dispatch}>
        <Room onError={onError}>
          <Exploding />
        </Room>
      </div>,
    );

    expect(dispatch).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("marks the fallback as a status so it is announced once, politely", () => {
    function Exploding(): React.ReactElement {
      throw new Error("boom");
    }
    render(
      <Room>
        <Exploding />
      </Room>,
    );
    const fallback = screen.getByTestId("visualization-unavailable");
    expect(fallback).toHaveAttribute("role", "status");
    expect(fallback.textContent).toMatch(/test itself is unaffected/i);
  });
});
