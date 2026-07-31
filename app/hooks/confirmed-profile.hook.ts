import { useCallback, useEffect, useState } from "react";

import { defaultProfile, saveProfile } from "~/lib/peer-profile";
import type { ConfirmedProfile } from "~/model/peer.model";

export interface ProfileDraftHandle {
  /** `undefined` until the stored/derived default resolves. */
  draft: ConfirmedProfile | undefined;
  setDraft: (profile: ConfirmedProfile) => void;
  /** Persists the trimmed draft and returns it. Both entry paths confirm the
   * same profile before entering a room (S8); "confirm" is just persisting it
   * right before the action that opens one. */
  persist: () => ConfirmedProfile;
}

/** Loaded unconditionally — `defaultProfile` is a localStorage read plus a UA
 * parse, never a network call. */
export function useProfileDraft(userAgent: string): ProfileDraftHandle {
  const [draft, setDraft] = useState<ConfirmedProfile>();

  useEffect(() => {
    void defaultProfile(userAgent).then(setDraft);
  }, [userAgent]);

  const persist = useCallback(() => {
    const confirmed: ConfirmedProfile = {
      privacyLevel: "off",
      ...draft,
      name: draft?.name.trim() ?? "",
    };
    saveProfile(confirmed);
    return confirmed;
  }, [draft]);

  return { draft, setDraft, persist };
}

export interface ConfirmedProfileHandle extends ProfileDraftHandle {
  /** `null` until this browser has confirmed a profile — no socket opens
   * before then (S8). */
  confirmed: ConfirmedProfile | null;
  confirm: () => void;
}

/**
 * The room's gate. Both create-and-join-from-home (profile arrives via router
 * state) and a pasted room link (no router state) confirm the same profile
 * before pairing.
 */
export function useConfirmedProfile(
  userAgent: string,
  initial: ConfirmedProfile | null = null,
): ConfirmedProfileHandle {
  const draft = useProfileDraft(userAgent);
  const [confirmed, setConfirmed] = useState<ConfirmedProfile | null>(initial);

  const confirm = useCallback(() => {
    if (!draft.draft?.name.trim()) return;
    setConfirmed(draft.persist());
  }, [draft]);

  return { ...draft, confirmed, confirm };
}
