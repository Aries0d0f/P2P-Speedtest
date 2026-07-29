import { useEffect, useRef, useState } from "react";
import type { Envelope, Slot } from "~/lib/protocol";
import { slugToToken, tokenToEmojiKey, tokenToSlug } from "~/lib/room-token";

import type { Route } from "./+types/room";

export function meta({}: Route.MetaArgs) {
  return [{ title: "P2P Speedtest — Room" }];
}

interface PeerInfo {
  slot: Slot;
  peerId: string;
}

interface EchoEntry {
  direction: "sent" | "received";
  text: string;
}

/**
 * A random, per-tab, per-room nonce persisted in sessionStorage. It exists
 * only so a refresh of this exact tab reconnects into the same slot instead
 * of racing its own about-to-close socket and pairing with itself; it is
 * never shared with the other peer and never restores any application
 * state (S3 still issues a fresh peerId on every accept).
 */
function getTabSessionId(slug: string): string {
  const key = `p2p-speedtest:room-session:${slug}`;
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;
  const created = crypto.randomUUID();
  sessionStorage.setItem(key, created);
  return created;
}

/**
 * Deliberately throwaway: this exists to verify the signaling backbone by
 * hand. Phase 2 replaces the indicator with the real waiting/pairing/
 * testing state machine; Phase 5 does the visual work.
 */
export default function Room({ params }: Route.ComponentProps) {
  const token = slugToToken(params.slug);

  const [status, setStatus] = useState<
    "connecting" | "open" | "closed" | "error"
  >("connecting");
  const [self, setSelf] = useState<
    (PeerInfo & { expiresAt: string }) | null
  >(null);
  const [other, setOther] = useState<PeerInfo | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [endedReason, setEndedReason] = useState<string | null>(null);
  const [log, setLog] = useState<EchoEntry[]>([]);
  const [draft, setDraft] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  const runIdRef = useRef<string | null>(null);
  const selfRef = useRef<PeerInfo | null>(null);

  useEffect(() => {
    if (token === null) return;

    // StrictMode double-invokes effects in development: setup, cleanup,
    // then setup again, synchronously. Deferring the actual connection to
    // a macrotask means that synthetic first cleanup runs before it ever
    // opens, so only the real mount ever performs a socket connect —
    // avoiding a wasted signaling round-trip on every dev page load.
    let ws: WebSocket | null = null;
    const timer = setTimeout(() => {
      const slug = tokenToSlug(token);
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const session = getTabSessionId(slug);
      ws = new WebSocket(
        `${proto}//${window.location.host}/api/room/${slug}?session=${session}`,
      );
      wsRef.current = ws;

      ws.addEventListener("open", () => setStatus("open"));
      ws.addEventListener("close", () => setStatus("closed"));
      ws.addEventListener("error", () => setStatus("error"));
      ws.addEventListener("message", (event) => {
        const envelope: Envelope = JSON.parse(event.data as string);
        switch (envelope.type) {
          case "peer-assigned":
            selfRef.current = envelope.payload;
            setSelf(envelope.payload);
            break;
          case "peer-joined":
            setOther(envelope.payload);
            break;
          case "run-started": {
            runIdRef.current = envelope.runId;
            setRunId(envelope.runId);
            const otherPeer = envelope.payload.peers.find(
              (p) => p.slot !== selfRef.current?.slot,
            );
            if (otherPeer) setOther(otherPeer);
            break;
          }
          case "run-ended":
            runIdRef.current = null;
            setRunId(null);
            setEndedReason(envelope.payload.reason);
            break;
          case "ping":
            ws?.send(
              JSON.stringify({
                type: "pong",
                runId: envelope.runId,
                payload: {},
              }),
            );
            break;
          case "ice-candidate":
            setLog((l) => [
              ...l,
              { direction: "received", text: String(envelope.payload) },
            ]);
            break;
          default:
            break;
        }
      });
    }, 0);

    return () => {
      clearTimeout(timer);
      ws?.close();
    };
  }, [token]);

  if (token === null) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4">
        <p className="text-sm text-red-600 dark:text-red-400">
          "{params.slug}" isn't a valid Room ID.
        </p>
      </main>
    );
  }

  const slug = tokenToSlug(token);
  const emojiKey = tokenToEmojiKey(token);
  const link =
    typeof window !== "undefined"
      ? `${window.location.origin}/room/${slug}`
      : `/room/${slug}`;

  function sendEcho() {
    if (!draft.trim() || !wsRef.current || runIdRef.current === null) return;
    wsRef.current.send(
      JSON.stringify({
        type: "ice-candidate",
        runId: runIdRef.current,
        payload: draft,
      }),
    );
    setLog((l) => [...l, { direction: "sent", text: draft }]);
    setDraft("");
  }

  return (
    <main className="flex min-h-screen flex-col items-center gap-8 px-4 py-16">
      <section className="flex w-full max-w-sm flex-col gap-3 rounded-2xl border border-gray-200 p-5 text-center dark:border-gray-700">
        <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Room ID
        </p>
        <p className="font-mono text-lg text-gray-900 dark:text-gray-100">{slug}</p>
        <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Emoji key
        </p>
        <p className="text-2xl">{emojiKey}</p>
        <p className="break-all text-xs text-gray-500 dark:text-gray-400">{link}</p>
      </section>

      <section className="w-full max-w-sm rounded-2xl border border-gray-200 p-5 text-center dark:border-gray-700">
        {status === "connecting" && <p>Connecting…</p>}
        {status === "error" && <p className="text-red-600 dark:text-red-400">
          Connection error.
        </p>}
        {status === "closed" && !endedReason && <p>Connection closed.</p>}
        {endedReason && <p>Room ended: {endedReason}.</p>}
        {status === "open" && !endedReason && (
          <p>{other ? "Peer joined!" : "Waiting for a peer…"}</p>
        )}
        {self && (
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            You are slot {self.slot}
            {other ? `, peer is slot ${other.slot}` : ""}
          </p>
        )}
      </section>

      <section className="flex w-full max-w-sm flex-col gap-2 rounded-2xl border border-gray-200 p-5 dark:border-gray-700">
        <h2 className="text-sm font-medium text-gray-700 dark:text-gray-200">
          Echo
        </h2>
        <div className="flex max-h-40 flex-col gap-1 overflow-y-auto text-sm">
          {log.map((entry, i) => (
            <p
              key={i}
              className={
                entry.direction === "sent"
                  ? "text-right text-gray-900 dark:text-gray-100"
                  : "text-left text-blue-700 dark:text-blue-400"
              }
            >
              {entry.text}
            </p>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendEcho()}
            disabled={runId === null}
            placeholder={runId === null ? "Waiting for a peer…" : "Say something"}
            className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:opacity-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          />
          <button
            type="button"
            onClick={sendEcho}
            disabled={runId === null}
            className="rounded-full bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900"
          >
            Send
          </button>
        </div>
      </section>
    </main>
  );
}
