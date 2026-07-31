import { useEffect } from "react";

import { prefetchGeo } from "~/lib/geo";
import { buildEnrichmentProfileMessage } from "~/lib/peer-profile";
import type { ConfirmedProfile, PeerProfile } from "~/model/peer.model";

/**
 * Starts the geo lookup at mount — during the waiting screen, before the
 * visitor has decided whether to join. It is slower than everything around it,
 * so waiting until the control channel opens left the globe marker-less for a
 * round trip after pairing. It shares nothing on its own: what leaves this
 * browser is still decided by the privacy level, at send time.
 *
 * Also publishes a *provisional* self marker as soon as the lookup lands, so
 * the waiting screen has something true on it. Display only — the profile that
 * authors this peer's entry in the stored record is written solely when a real
 * `peer-profile` message is sent.
 */
export function useGeoPrefetch(
  enabled: boolean,
  profile: ConfirmedProfile | null,
  userAgent: string,
  onProvisionalSelfProfile: (profile: PeerProfile) => void,
): void {
  useEffect(() => {
    if (!enabled) return;
    void prefetchGeo();
  }, [enabled]);

  useEffect(() => {
    if (!profile) return;
    let cancelled = false;
    void prefetchGeo().then((geo) => {
      if (cancelled || !geo) return;
      // No address yet — there is no peer connection to read one from — but
      // the privacy projection is the same one the wire message uses.
      onProvisionalSelfProfile(buildEnrichmentProfileMessage(profile, userAgent, {}, geo));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, userAgent]);
}
