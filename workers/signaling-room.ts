import { DurableObject } from "cloudflare:workers";
import { v5 as uuidv5 } from "uuid";
import {
  EXPIRED_CLOSE_CODE,
  isEnvelope,
  type Envelope,
  type RunEndedReason,
  type Slot,
  type TestConfigPayload,
} from "~/lib/protocol";
import { getCurrentTestConfig } from "./test-config";

// Project-wide fixed namespace for peer-id derivation (S3). Any fixed value
// works: peer ids live and die with a room, so nothing is invalidated if
// this changes across a deploy that hasn't shipped yet. Never change it
// once rooms depending on it are live.
const PEER_ID_NAMESPACE = "1d9f4b7a-0e4c-4f7d-9c8e-6a2b7f0e5d31";

interface TimingConfig {
  hardExpiryMs: number;
  idleWindowMs: number;
  heartbeatIntervalMs: number;
  finalizationGraceMs: number;
}

let TIMING: TimingConfig = {
  hardExpiryMs: 10 * 60 * 1000, // S1: ~10 minutes from reservation
  idleWindowMs: 2 * 60 * 1000,
  heartbeatIntervalMs: 15 * 1000,
  finalizationGraceMs: 5 * 1000,
};

/** Test-only hook: shrinks the real-time windows above so heartbeat/expiry/
 * finalization tests don't have to sleep for minutes of wall-clock time. */
export function setTimingForTesting(overrides: Partial<TimingConfig>): void {
  TIMING = { ...TIMING, ...overrides };
}

interface SlotAttachment {
  slot: Slot;
  peerId: string;
  gen: string;
  sessionId: string | null;
}

interface HeartbeatDeadlines {
  pingDueAt: number;
  staleAt: number;
  // Ties this deadline to the specific socket instance that created it. A
  // slot's old occupant can be replaced and its close event only processed
  // afterward; without this, that late close would delete the *new*
  // occupant's fresh heartbeat entry out from under it.
  gen: string;
}

function otherSlot(slot: Slot): Slot {
  return slot === 0 ? 1 : 0;
}

function generateGen(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function computePeerId(slug: string, slot: Slot, gen: string): string {
  return uuidv5(`room:${slug}|slot:${slot}|gen:${gen}`, PEER_ID_NAMESPACE);
}

export class SignalingRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  // --- RPC surface -------------------------------------------------------

  /**
   * Atomically claims this room under `slug`, snapshotting the test config
   * and starting the expiry clock. Returns false on collision (already
   * claimed), so the caller can regenerate and retry.
   */
  async claim(slug: string): Promise<boolean> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const alreadyClaimed = await this.ctx.storage.get<boolean>("claimed");
      if (alreadyClaimed) return false;

      const now = Date.now();
      await this.ctx.storage.put({
        claimed: true,
        slug,
        expiresAt: now + TIMING.hardExpiryMs,
        lastActivityAt: now,
        runId: null,
        terminal: false,
        testConfig: getCurrentTestConfig(),
        "finish:0": false,
        "finish:1": false,
        finishDeadline: null,
      });
      await this.scheduleAlarm();
      return true;
    });
  }

  // --- WebSocket upgrade ---------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    return this.ctx.blockConcurrencyWhile(async () => {
      const claimed = await this.ctx.storage.get<boolean>("claimed");
      if (!claimed) {
        return new Response("Room not found", { status: 404 });
      }
      const terminal = await this.ctx.storage.get<boolean>("terminal");
      if (terminal) {
        return new Response("Room has ended", { status: 410 });
      }

      const occupied = new Map<Slot, WebSocket>();
      for (const ws of this.ctx.getWebSockets()) {
        const attachment = ws.deserializeAttachment() as SlotAttachment | null;
        if (attachment) occupied.set(attachment.slot, ws);
      }

      const runId = await this.ctx.storage.get<string | null>("runId");
      const sessionId = new URL(request.url).searchParams.get("session");

      let slot: Slot | undefined;

      // A refresh opens a new socket before the old one is necessarily
      // detected as gone, which would otherwise race the normal
      // empty-or-stale slot pick below and pair the tab with itself in the
      // other slot. A matching session id — a nonce private to this
      // browser tab, never shared with the other peer — means this is
      // provably the same tab reconnecting, so it takes its own slot back
      // immediately regardless of staleness. Only pre-run: once a run has
      // started a departure ends the room (S2), not a silent reconnect.
      if (runId == null && sessionId) {
        for (const [candidate, ws] of occupied) {
          const attachment = ws.deserializeAttachment() as SlotAttachment | null;
          if (attachment?.sessionId === sessionId) {
            try {
              ws.close(1000, "reconnected");
            } catch {
              // already gone
            }
            await this.ctx.storage.delete(`heartbeat:${candidate}`);
            occupied.delete(candidate);
            slot = candidate;
            break;
          }
        }
      }

      // "The first free slot in order — 0 if empty or stale, otherwise 1."
      // Replacing a live-but-unresponsive slot is only ever allowed before a
      // run has started; once runId is set both slots are guaranteed live
      // (see the reasoning in handleSlotGone), so this never opens a live
      // run's slot to a third joiner.
      if (slot === undefined) {
        for (const candidate of [0, 1] as const) {
          if (!occupied.has(candidate)) {
            slot = candidate;
            break;
          }
          if (runId == null && (await this.isSlotStale(candidate))) {
            try {
              occupied.get(candidate)?.close(1000, "replaced");
            } catch {
              // already gone
            }
            await this.ctx.storage.delete(`heartbeat:${candidate}`);
            occupied.delete(candidate);
            slot = candidate;
            break;
          }
        }
      }
      if (slot === undefined) {
        return new Response("Room is full", { status: 409 });
      }

      const slug = (await this.ctx.storage.get<string>("slug"))!;
      const gen = generateGen();
      const peerId = computePeerId(slug, slot, gen);

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({
        slot,
        peerId,
        gen,
        sessionId,
      } satisfies SlotAttachment);

      const now = Date.now();
      await this.ctx.storage.put(`heartbeat:${slot}`, {
        pingDueAt: now + TIMING.heartbeatIntervalMs,
        staleAt: now + 2 * TIMING.heartbeatIntervalMs,
        gen,
      } satisfies HeartbeatDeadlines);
      await this.ctx.storage.put("lastActivityAt", now);

      const expiresAt = (await this.ctx.storage.get<number>("expiresAt"))!;
      const testConfig =
        (await this.ctx.storage.get<TestConfigPayload>("testConfig"))!;

      this.safeSend(server, {
        type: "peer-assigned",
        runId: null,
        payload: { slot, peerId, expiresAt: new Date(expiresAt).toISOString() },
      });
      this.safeSend(server, {
        type: "test-config",
        runId: null,
        payload: testConfig,
      });

      // The other slot is only ever already live here when this accept is
      // the second peer, since replacement only fires while runId is null.
      const otherWs = [...occupied.entries()].find(([s]) => s !== slot)?.[1];
      if (otherWs) {
        const otherAttachment = otherWs.deserializeAttachment() as SlotAttachment;
        const newRunId = crypto.randomUUID();
        await this.ctx.storage.put({
          runId: newRunId,
          "finish:0": false,
          "finish:1": false,
          finishDeadline: null,
        });

        this.safeSend(otherWs, {
          type: "peer-joined",
          runId: newRunId,
          payload: { slot, peerId },
        });

        const peers: [{ slot: 0; peerId: string }, { slot: 1; peerId: string }] =
          slot === 0
            ? [
                { slot: 0, peerId },
                { slot: 1, peerId: otherAttachment.peerId },
              ]
            : [
                { slot: 0, peerId: otherAttachment.peerId },
                { slot: 1, peerId },
              ];
        this.broadcastTo([server, otherWs], {
          type: "run-started",
          runId: newRunId,
          payload: { peers },
        });
      }

      await this.scheduleAlarm();

      return new Response(null, { status: 101, webSocket: client });
    });
  }

  // --- Hibernatable WebSocket hooks ---------------------------------------

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof message !== "string") return; // binary bulk framing is Phase 4

    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    if (!isEnvelope(parsed)) return;

    const attachment = ws.deserializeAttachment() as SlotAttachment | null;
    if (!attachment) return;

    const now = Date.now();
    await this.ctx.storage.put("lastActivityAt", now);

    switch (parsed.type) {
      case "pong": {
        await this.ctx.storage.put(`heartbeat:${attachment.slot}`, {
          pingDueAt: now + TIMING.heartbeatIntervalMs,
          staleAt: now + 2 * TIMING.heartbeatIntervalMs,
          gen: attachment.gen,
        } satisfies HeartbeatDeadlines);
        await this.scheduleAlarm();
        return;
      }
      case "run-finished": {
        await this.handleRunFinished(attachment.slot, parsed.runId);
        return;
      }
      case "offer":
      case "answer":
      case "ice-candidate": {
        await this.relayIfCurrentRun(attachment.slot, parsed);
        return;
      }
      default:
        // Server-authoritative types received from a client are ignored.
        return;
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as SlotAttachment | null;
    if (!attachment) return;
    await this.handleSlotGone(attachment.slot, ws, attachment.gen);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as SlotAttachment | null;
    if (!attachment) return;
    await this.handleSlotGone(attachment.slot, ws, attachment.gen);
  }

  // --- Alarm: hard expiry, heartbeat, finalization grace, idle cleanup ---

  async alarm(): Promise<void> {
    const now = Date.now();

    const claimed = await this.ctx.storage.get<boolean>("claimed");
    const terminal = await this.ctx.storage.get<boolean>("terminal");
    if (!claimed || terminal) {
      await this.cleanupAndDelete();
      return;
    }

    const expiresAt = (await this.ctx.storage.get<number>("expiresAt"))!;
    if (now >= expiresAt) {
      await this.endRoom("expired", { closeCode: EXPIRED_CLOSE_CODE });
      await this.cleanupAndDelete();
      return;
    }

    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as SlotAttachment | null;
      if (!attachment) continue;
      const hb = await this.ctx.storage.get<HeartbeatDeadlines>(
        `heartbeat:${attachment.slot}`,
      );
      if (!hb) continue;

      if (now >= hb.staleAt) {
        const ended = await this.handleSlotGone(attachment.slot, ws, attachment.gen);
        if (ended) return;
      } else if (now >= hb.pingDueAt) {
        const runId = await this.ctx.storage.get<string | null>("runId");
        this.safeSend(ws, { type: "ping", runId: runId ?? null, payload: {} });
        await this.ctx.storage.put(`heartbeat:${attachment.slot}`, {
          pingDueAt: now + TIMING.heartbeatIntervalMs,
          staleAt: hb.staleAt,
          gen: attachment.gen,
        } satisfies HeartbeatDeadlines);
      }
    }

    const finishDeadline = await this.ctx.storage.get<number | null>(
      "finishDeadline",
    );
    if (finishDeadline != null && now >= finishDeadline) {
      const finish0 = await this.ctx.storage.get<boolean>("finish:0");
      const finish1 = await this.ctx.storage.get<boolean>("finish:1");
      if (!(finish0 && finish1)) {
        await this.endRoom("finalization-timeout");
        await this.cleanupAndDelete();
        return;
      }
    }

    const noLiveSockets = this.ctx.getWebSockets().length === 0;
    const lastActivityAt =
      (await this.ctx.storage.get<number>("lastActivityAt")) ?? now;
    if (noLiveSockets && now - lastActivityAt >= TIMING.idleWindowMs) {
      await this.cleanupAndDelete();
      return;
    }

    await this.scheduleAlarm();
  }

  // --- Internals -----------------------------------------------------------

  private async isSlotStale(slot: Slot): Promise<boolean> {
    const hb = await this.ctx.storage.get<HeartbeatDeadlines>(
      `heartbeat:${slot}`,
    );
    if (!hb) return true;
    return Date.now() >= hb.staleAt;
  }

  private async handleRunFinished(
    slot: Slot,
    messageRunId: string,
  ): Promise<void> {
    const runId = await this.ctx.storage.get<string | null>("runId");
    if (!runId || messageRunId !== runId) return; // drop: stale or no current run

    const already = await this.ctx.storage.get<boolean>(`finish:${slot}`);
    if (already) return; // idempotent no-op

    await this.ctx.storage.put(`finish:${slot}`, true);

    const finishDeadline = await this.ctx.storage.get<number | null>(
      "finishDeadline",
    );
    if (finishDeadline == null) {
      await this.ctx.storage.put(
        "finishDeadline",
        Date.now() + TIMING.finalizationGraceMs,
      );
    }

    const otherFinished = await this.ctx.storage.get<boolean>(
      `finish:${otherSlot(slot)}`,
    );
    if (otherFinished) {
      await this.endRoom("complete");
      await this.cleanupAndDelete();
      return;
    }

    await this.scheduleAlarm();
  }

  private async relayIfCurrentRun(
    fromSlot: Slot,
    envelope: Extract<Envelope, { type: "offer" | "answer" | "ice-candidate" }>,
  ): Promise<void> {
    const runId = await this.ctx.storage.get<string | null>("runId");
    if (!runId || envelope.runId !== runId) return;

    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as SlotAttachment | null;
      if (attachment && attachment.slot !== fromSlot) {
        this.safeSend(ws, envelope);
        return;
      }
    }
  }

  /**
   * Common path for a slot disappearing: clean close, network death, or a
   * heartbeat timeout. Once a run has started, S2 makes the room terminal
   * rather than leaving the survivor waiting for a replacement. Returns
   * true if this call ended and cleaned up the room.
   *
   * `gen` identifies the specific socket instance this event is about. A
   * close event can arrive after that slot has already been replaced (the
   * old socket's own close, processed late), so the heartbeat entry is only
   * deleted if it still belongs to this same generation — otherwise it
   * belongs to whoever replaced it, and must be left alone.
   */
  private async handleSlotGone(
    slot: Slot,
    ws?: WebSocket,
    gen?: string,
  ): Promise<boolean> {
    const claimed = await this.ctx.storage.get<boolean>("claimed");
    if (!claimed) return true; // already cleaned up; ignore a stray event

    const currentHeartbeat = await this.ctx.storage.get<HeartbeatDeadlines>(
      `heartbeat:${slot}`,
    );
    if (!currentHeartbeat || currentHeartbeat.gen === gen) {
      await this.ctx.storage.delete(`heartbeat:${slot}`);
    }
    if (ws) {
      try {
        ws.close(1000, "gone");
      } catch {
        // already closed
      }
    }

    const runId = await this.ctx.storage.get<string | null>("runId");
    const terminal = await this.ctx.storage.get<boolean>("terminal");
    if (runId && !terminal) {
      await this.endRoom("peer-left");
      await this.cleanupAndDelete();
      return true;
    }

    await this.ctx.storage.put("lastActivityAt", Date.now());
    await this.scheduleAlarm();
    return false;
  }

  private async endRoom(
    reason: RunEndedReason,
    opts?: { closeCode?: number },
  ): Promise<void> {
    const runId = await this.ctx.storage.get<string | null>("runId");
    this.broadcast({ type: "run-ended", runId: runId ?? null, payload: { reason } });
    await this.ctx.storage.put("terminal", true);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(opts?.closeCode ?? 1000, reason);
      } catch {
        // already closed
      }
    }
  }

  private async cleanupAndDelete(): Promise<void> {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }

  private async computeNextAlarmTime(): Promise<number> {
    const expiresAt =
      (await this.ctx.storage.get<number>("expiresAt")) ?? Infinity;
    const lastActivityAt =
      (await this.ctx.storage.get<number>("lastActivityAt")) ?? Date.now();
    const finishDeadline =
      (await this.ctx.storage.get<number | null>("finishDeadline")) ?? Infinity;

    let heartbeatDeadline = Infinity;
    for (const slot of [0, 1] as const) {
      const hb = await this.ctx.storage.get<HeartbeatDeadlines>(
        `heartbeat:${slot}`,
      );
      if (hb) {
        heartbeatDeadline = Math.min(heartbeatDeadline, hb.pingDueAt, hb.staleAt);
      }
    }

    return Math.min(
      expiresAt,
      lastActivityAt + TIMING.idleWindowMs,
      heartbeatDeadline,
      finishDeadline,
    );
  }

  private async scheduleAlarm(): Promise<void> {
    const next = await this.computeNextAlarmTime();
    if (Number.isFinite(next)) {
      await this.ctx.storage.setAlarm(next);
    }
  }

  private safeSend(ws: WebSocket, envelope: Envelope): void {
    try {
      ws.send(JSON.stringify(envelope));
    } catch {
      // socket already gone; nothing to do
    }
  }

  private broadcastTo(sockets: WebSocket[], envelope: Envelope): void {
    for (const ws of sockets) this.safeSend(ws, envelope);
  }

  private broadcast(envelope: Envelope): void {
    this.broadcastTo(this.ctx.getWebSockets(), envelope);
  }
}
