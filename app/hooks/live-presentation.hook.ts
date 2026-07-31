import { useMemo } from "react";

import { selectLiveTestPresentation } from "~/lib/presentation-selector";
import type { LiveTestPresentation, LiveTestRoomView } from "~/model/presentation.model";
import type { RoomState } from "~/model/room.model";

/**
 * One pure snapshot, recomputed only when the room state it reads changes.
 * Everything animated downstream sees this and nothing else: no channel, no
 * orchestrator, no timer, no sender-side byte counter.
 */
export function useLivePresentation(state: RoomState): LiveTestPresentation {
  const {
    runId,
    phase,
    stageId,
    stageProgress,
    liveLatency,
    latencyBaseline,
    connectionType,
    selfProfile,
    otherProfile,
  } = state;
  const localSlot = state.self?.slot ?? null;

  return useMemo(() => {
    const view: LiveTestRoomView = {
      runId,
      phase,
      stageId,
      stageProgress,
      liveLatency,
      latencyBaseline,
      connectionType,
      selfProfile,
      otherProfile,
    };
    return selectLiveTestPresentation(view, localSlot ?? 0);
  }, [
    runId,
    phase,
    stageId,
    stageProgress,
    liveLatency,
    latencyBaseline,
    connectionType,
    selfProfile,
    otherProfile,
    localSlot,
  ]);
}
