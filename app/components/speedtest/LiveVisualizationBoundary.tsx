import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * A component-local error boundary for the optional live visualization
 * (06-live-test-visualization 6.5).
 *
 * Deliberately narrow. It catches a rejected client-only import and any
 * synchronous render or lifecycle exception from the dashboard subtree, and
 * replaces *only* that subtree. It never dispatches a room action, never
 * resets test state, and is mounted as a sibling of the core test panel so
 * the numeric metrics, status, connection badge and Cancel button cannot be
 * inside anything it can unmount.
 *
 * React error boundaries cannot see exceptions thrown later from an
 * imperative `requestAnimationFrame`, a loader callback, or an Anime.js
 * callback. Those owners catch their own and call `onVisualError`, which
 * routes into the same fallback through `failed`.
 */

export interface LiveVisualizationBoundaryProps {
  children: ReactNode;
  /**
   * Changing this remounts the boundary and clears a previous failure — the
   * room passes `runId`, so a new run starts clean while a failure inside one
   * run stays failed for that run rather than retrying a cached rejected
   * module promise four times a second.
   */
  resetKey?: string | null;
  /** Set by an imperative failure reported from inside the subtree. */
  failed?: boolean;
  /** Reported once, for diagnosis only. */
  onError?: (error: unknown) => void;
}

interface State {
  error: unknown;
}

export class LiveVisualizationBoundary extends Component<LiveVisualizationBoundaryProps, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // Local diagnosis only — nothing here reaches the room reducer.
    console.warn("live visualization failed", error, info.componentStack);
    this.props.onError?.(error);
  }

  componentDidUpdate(previous: LiveVisualizationBoundaryProps) {
    if (previous.resetKey !== this.props.resetKey && this.state.error !== null) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error !== null || this.props.failed) {
      return <VisualizationUnavailable />;
    }
    return this.props.children;
  }
}

export function VisualizationUnavailable() {
  return (
    <div
      role="status"
      data-testid="visualization-unavailable"
      className="surface-panel flex w-full items-center justify-center rounded-2xl border border-dashed border-gray-300 p-6 text-center dark:border-gray-700"
    >
      <p className="text-xs text-gray-500 dark:text-gray-400">
        The enhanced visualization isn't available here. The test itself is unaffected — every
        measurement below is live.
      </p>
    </div>
  );
}

export function VisualizationPending() {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="visualization-pending"
      className="surface-panel flex w-full items-center justify-center rounded-2xl border border-gray-200 p-6 text-center dark:border-gray-700"
    >
      <p className="text-xs text-gray-500 dark:text-gray-400">Loading the live view…</p>
    </div>
  );
}
