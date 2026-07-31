import { useCallback, useEffect, useRef } from "react";

import { EXPIRED_CLOSE_CODE, type Envelope } from "~/model/signaling.model";
import type { RoomRunContext } from "~/model/room.model";
import { useLatest } from "./latest.hook";

export interface SignalingSocketOptions {
  onEnvelope: (envelope: Envelope) => void;
  /** The DO's hard-expiry close code, distinct from a normal closure so the
   * room can say "this room expired" even if `run-ended` itself was lost. */
  onExpired: () => void;
}

export interface SignalingSocketHandle {
  send: (envelope: Envelope) => void;
  close: (code: number, reason: string) => void;
}

/** A per-tab nonce, so two tabs on the same room stay distinguishable to the
 * DO's slot bookkeeping. */
function getTabSessionId(slug: string): string {
  const key = `p2p-speedtest:room-session:${slug}`;
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;
  const created = crypto.randomUUID();
  sessionStorage.setItem(key, created);
  return created;
}

export function useSignalingSocket(
  ctx: React.RefObject<RoomRunContext>,
  enabled: boolean,
  opts: SignalingSocketOptions,
): SignalingSocketHandle {
  const wsRef = useRef<WebSocket | null>(null);
  const latest = useLatest(opts);

  const send = useCallback((envelope: Envelope) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(envelope));
    } catch {
      // socket already gone
    }
  }, []);

  const close = useCallback((code: number, reason: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      // The specific local reason travels in the close reason (well under the
      // 123-byte limit) so a failure is diagnosable from the wire alone.
      ws.close(code, reason);
    } catch {
      // already closing
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;

    // StrictMode double-invokes effects in development: setup, cleanup, then
    // setup again, synchronously. Deferring the connect to a macrotask means
    // that synthetic first cleanup runs before any socket opens, so only the
    // real mount ever performs a connect.
    let ws: WebSocket | null = null;
    const timer = setTimeout(() => {
      const slug = ctx.current.slug;
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const session = getTabSessionId(slug);
      ws = new WebSocket(`${proto}//${window.location.host}/api/room/${slug}?session=${session}`);
      wsRef.current = ws;

      ws.addEventListener("close", (event) => {
        if (ctx.current.terminal || event.code !== EXPIRED_CLOSE_CODE) return;
        latest.current.onExpired();
      });

      ws.addEventListener("message", (event) => {
        latest.current.onEnvelope(JSON.parse(event.data as string) as Envelope);
      });
    }, 0);

    return () => {
      clearTimeout(timer);
      ws?.close();
      wsRef.current = null;
    };
  }, [ctx, latest, enabled]);

  return { send, close };
}
