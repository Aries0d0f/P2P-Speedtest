import { useCallback, useEffect, useRef } from "react";

import { prefetchGeo } from "~/lib/geo";
import { encodeControlMessage } from "~/lib/control-message";
import {
  buildEnrichmentProfileMessage,
  buildInitialProfileMessage,
  sanitizeIncomingProfile,
  validateInitialProfile,
} from "~/lib/peer-profile";
import type { OwnAddress } from "~/model/connection.model";
import type { PeerProfile } from "~/model/peer.model";
import type { RoomRunContext } from "~/model/room.model";
import { useLatest } from "./latest.hook";

// A missing/invalid initial profile must not strand the room forever — this
// bounds how long `pairing` waits before treating it as a failure (2.6's
// testing-barrier prerequisite).
const PROFILE_TIMEOUT_MS = 20_000;

export interface PeerProfileExchangeOptions {
  userAgent: string;
  getOwnAddress: () => Promise<OwnAddress>;
  sendControlRaw: (raw: string) => void;
  onSelfProfile: (profile: PeerProfile) => void;
  onOtherProfile: (update: (prev: PeerProfile | null) => PeerProfile) => void;
  onRunTimestamp: (timestamp: string) => void;
  /** Both halves of the barrier are in hand: this side may send
   * `channel-ready`. */
  onExchangeComplete: () => void;
  onTimeout: () => void;
}

export interface PeerProfileExchangeHandle {
  /** Runs on control-channel open: sends the initial profile, then the geo
   * enrichment tail. */
  begin: (channel: RTCDataChannel) => Promise<void>;
  /** Returns true once the peer's *initial* profile has validated. */
  handleIncoming: (payload: unknown) => void;
  armTimeout: () => void;
  clearTimeout: () => void;
}

export function usePeerProfileExchange(
  ctx: React.RefObject<RoomRunContext>,
  opts: PeerProfileExchangeOptions,
): PeerProfileExchangeHandle {
  const latest = useLatest(opts);
  const initialSentRef = useRef(false);
  const initialReceivedRef = useRef(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  useEffect(() => clear, [clear]);

  const armTimeout = useCallback(() => {
    timeoutRef.current = setTimeout(() => {
      if (!(initialSentRef.current && initialReceivedRef.current)) latest.current.onTimeout();
    }, PROFILE_TIMEOUT_MS);
  }, [latest]);

  const maybeComplete = useCallback(() => {
    if (!(initialSentRef.current && initialReceivedRef.current)) return;
    clear();
    latest.current.onExchangeComplete();
  }, [clear, latest]);

  const begin = useCallback(
    async (channel: RTCDataChannel) => {
      const self = ctx.current.self;
      const runId = ctx.current.runId;
      if (!self || !runId) return;
      const o = latest.current;

      const address = await o.getOwnAddress();
      if (ctx.current.terminal || ctx.current.runId !== runId) return;

      const initial = await buildInitialProfileMessage(
        ctx.current.profile,
        o.userAgent,
        address,
        self.slot,
      );
      if (ctx.current.terminal || ctx.current.runId !== runId) return;
      ctx.current.selfProfile = initial;
      o.onSelfProfile(initial);
      if (initial.timestamp) o.onRunTimestamp(initial.timestamp); // slot 0 only (S6)
      try {
        channel.send(encodeControlMessage({ type: "peer-profile", runId, payload: initial }));
      } catch (err) {
        console.warn("failed to send initial profile", err);
        return;
      }
      initialSentRef.current = true;
      maybeComplete();

      // Geo enrichment: fire-and-forget, never blocks or re-gates pairing, and
      // a failure anywhere in this tail must never be mistaken for the initial
      // send above already having failed.
      try {
        // Normally already resolved by the prefetch at mount, so the enriched
        // profile goes out on the heels of the initial one.
        const geo = await prefetchGeo();
        if (ctx.current.terminal || ctx.current.runId !== runId) return;
        const freshAddress = await o.getOwnAddress();
        if (ctx.current.terminal || ctx.current.runId !== runId) return;
        const enrichment = await buildEnrichmentProfileMessage(
          ctx.current.profile,
          o.userAgent,
          freshAddress,
          geo,
        );
        if (ctx.current.terminal || ctx.current.runId !== runId) return;
        ctx.current.selfProfile = enrichment;
        o.onSelfProfile(enrichment);
        channel.send(encodeControlMessage({ type: "peer-profile", runId, payload: enrichment }));
      } catch (err) {
        console.warn("profile enrichment failed", err);
      }
    },
    [ctx, latest, maybeComplete],
  );

  const handleIncoming = useCallback(
    (payload: unknown) => {
      const otherSlot = ctx.current.other?.slot;
      if (otherSlot === undefined) return;

      if (!initialReceivedRef.current) {
        const validated = validateInitialProfile(payload, otherSlot);
        // An invalid initial profile times out in `pairing` rather than
        // crashing the run.
        if (!validated) return;
        initialReceivedRef.current = true;
        // Slot 0's profile only (S6).
        if (validated.timestamp) latest.current.onRunTimestamp(validated.timestamp);
        ctx.current.otherProfile = validated;
        latest.current.onOtherProfile(() => validated);
        maybeComplete();
        return;
      }

      const enrichment = sanitizeIncomingProfile(payload);
      if (!enrichment) return;
      latest.current.onOtherProfile((prev) => (prev ? { ...prev, ...enrichment } : enrichment));
    },
    [ctx, latest, maybeComplete],
  );

  return { begin, handleIncoming, armTimeout, clearTimeout: clear };
}
