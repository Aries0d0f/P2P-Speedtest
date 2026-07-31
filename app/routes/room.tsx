import { Suspense, lazy } from "react";
import { useLocation } from "react-router";

import { ProfileGate } from "~/components/room/ProfileGate";
import { ResultSummary } from "~/components/room/ResultSummary";
import { RoomSummary } from "~/components/room/RoomSummary";
import { TerminalPanel } from "~/components/room/TerminalPanel";
import { TestPanel } from "~/components/room/TestPanel";
import {
  LiveVisualizationBoundary,
  VisualizationPending,
} from "~/components/speedtest/LiveVisualizationBoundary";
import { useConfirmedProfile } from "~/hooks/confirmed-profile.hook";
import { useGeoPrefetch } from "~/hooks/geo-prefetch.hook";
import { useLivePresentation } from "~/hooks/live-presentation.hook";
import { useRoomLink } from "~/hooks/room-link.hook";
import { useRoomSession } from "~/hooks/room-session.hook";
import { useVisualFailure } from "~/hooks/visual-failure.hook";
import { slugToToken } from "~/lib/room-token";
import type { ConfirmedProfile } from "~/model/peer.model";

import type { Route } from "./+types/room";

export function meta({}: Route.MetaArgs) {
  return [{ title: "P2P Speedtest — Room" }];
}

const USER_AGENT = typeof navigator !== "undefined" ? navigator.userAgent : "";

/**
 * The optional live visualization. Lazy so the Three.js, Anime.js and land-mask
 * chunks are fetched only by a browser that actually reaches `testing` — the
 * home and results routes never download them. Mounted as a *sibling* of the
 * core test panel, never as its parent.
 */
const LiveTestDashboard = lazy(() => import("~/components/speedtest/LiveTestDashboard"));

export default function Room({ params }: Route.ComponentProps) {
  const token = slugToToken(params.slug);
  const location = useLocation();
  const link = useRoomLink(token);

  const profile = useConfirmedProfile(
    USER_AGENT,
    (location.state as { profile?: ConfirmedProfile } | null | undefined)?.profile ?? null,
  );

  const { state, cancel, setProvisionalSelfProfile } = useRoomSession(
    token,
    link?.slug ?? "",
    profile.confirmed,
    USER_AGENT,
  );

  useGeoPrefetch(token !== null, profile.confirmed, USER_AGENT, setProvisionalSelfProfile);

  const presentation = useLivePresentation(state);
  const visual = useVisualFailure(state.runId);

  if (token === null || link === null) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4">
        <p className="text-sm text-red-600 dark:text-red-400">
          "{params.slug}" isn't a valid Room ID.
        </p>
      </main>
    );
  }

  const roomSummary = <RoomSummary slug={link.slug} emojiKey={link.emojiKey} link={link.link} />;

  if (profile.confirmed === null) {
    return (
      <main className="flex min-h-screen flex-col items-center gap-8 px-4 py-16">
        {roomSummary}
        <ProfileGate
          draft={profile.draft}
          onDraftChange={profile.setDraft}
          onConfirm={profile.confirm}
          userAgent={USER_AGENT}
        />
      </main>
    );
  }

  return (
    // `relative` is load-bearing: the globe layer is a fixed element portalled
    // to the front of <body>, so this has to be positioned too for document
    // order — rather than a z-index — to put the page on top of it.
    <main className="relative flex min-h-screen flex-col items-center gap-8 px-4 py-16">
      {roomSummary}

      <section className="surface-panel flex w-full max-w-sm flex-col items-center gap-4 rounded-2xl border border-gray-200 p-5 dark:border-gray-700">
        {state.terminal ? (
          <TerminalPanel reason={state.terminal.reason} />
        ) : state.phase === "result" && state.outcome ? (
          <ResultSummary
            outcome={state.outcome}
            onNewRoom={() => {
              window.location.href = "/";
            }}
          />
        ) : (
          <TestPanel state={state} onCancel={cancel} />
        )}
      </section>

      {/*
        The optional enhancement, a sibling of the core panel above and never
        its parent: a rejected chunk, a thrown child, or an imperative
        Three.js/Anime.js failure can only replace this block. The metrics,
        stage, connection badge and Cancel button stay mounted and functional
        in every one of those cases.

        Mounted for the whole life of the room, not just `testing`: the globe
        gives the waiting and pairing screens something true to show, picks up
        each peer's location the moment it arrives, and stays up with the run's
        finished trace beside the result. It stays hidden on a terminal error
        screen, where the only useful thing is the reason.
      */}
      {!state.terminal && state.self && (
        <div className="w-full max-w-3xl">
          <LiveVisualizationBoundary
            resetKey={state.runId}
            failed={visual.failed}
            onError={visual.onVisualError}
          >
            <Suspense fallback={<VisualizationPending />}>
              <LiveTestDashboard
                presentation={presentation}
                onVisualError={visual.onVisualError}
              />
            </Suspense>
          </LiveVisualizationBoundary>
        </div>
      )}
    </main>
  );
}
