import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { Envelope } from "~/lib/protocol";
import { setTimingForTesting } from "./signaling-room";
import {
  getCurrentTestConfig,
  setCurrentTestConfigForTesting,
} from "./test-config";

// Real production windows (minutes/tens-of-seconds) would make these tests
// take that long to observe. Shrinking them doesn't change any logic path,
// only how long the test has to wait for it.
const FAST_TIMING = {
  hardExpiryMs: 200,
  idleWindowMs: 150,
  heartbeatIntervalMs: 40,
  finalizationGraceMs: 60,
  // 0 so a room's whole (shrunk) hard-expiry window doesn't itself trip the
  // TTL floor below — that path gets its own dedicated hardExpiryMs/floor
  // pairing in the "ice-servers issuance" tests instead.
  turnCredentialDefaultTtlMs: 60 * 60 * 1000,
  turnCredentialFloorMs: 0,
};

function getStub(name: string) {
  return env.SIGNALING_ROOM.getByName(name);
}

async function connect(
  stub: ReturnType<typeof getStub>,
  opts?: { autoPong?: boolean; sessionId?: string },
) {
  const url = opts?.sessionId
    ? `http://do/room?session=${opts.sessionId}`
    : "http://do/room";
  const resp = await stub.fetch(url, {
    headers: { Upgrade: "websocket" },
  });
  if (resp.status !== 101 || !resp.webSocket) {
    return { status: resp.status, ws: null as never, messages: [] as Envelope[] };
  }
  const ws = resp.webSocket;
  const messages: Envelope[] = [];
  ws.accept();
  ws.addEventListener("message", (event: MessageEvent) => {
    const envelope: Envelope = JSON.parse(event.data as string);
    messages.push(envelope);
    if (opts?.autoPong && envelope.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", runId: envelope.runId, payload: {} }));
    }
  });
  return { status: 101, ws, messages };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
) {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(() => {
  setTimingForTesting(FAST_TIMING);
  setCurrentTestConfigForTesting({
    maxDurationMs: 30_000,
    maxBytes: 250_000_000,
    chunkBytes: 65_536,
  });
});

describe("claim", () => {
  it("claims a fresh room and rejects a second claim", async () => {
    const stub = getStub("room-claim-1");
    expect(await stub.claim("room-claim-1")).toBe(true);
    expect(await stub.claim("room-claim-1")).toBe(false);
  });
});

describe("connection and peer assignment", () => {
  it("assigns distinct slots and peer ids to two sockets", async () => {
    const stub = getStub("room-slots-1");
    await stub.claim("room-slots-1");

    const a = await connect(stub);
    const b = await connect(stub);
    await waitFor(() => a.messages.length >= 1 && b.messages.length >= 1);

    const aAssigned = a.messages.find((m) => m.type === "peer-assigned");
    const bAssigned = b.messages.find((m) => m.type === "peer-assigned");
    expect(aAssigned?.payload.slot).toBe(0);
    expect(bAssigned?.payload.slot).toBe(1);
    expect(aAssigned?.payload.peerId).not.toBe(bAssigned?.payload.peerId);
  });

  it("sends peer-assigned before any other message", async () => {
    const stub = getStub("room-order-1");
    await stub.claim("room-order-1");
    const a = await connect(stub);
    await waitFor(() => a.messages.length >= 1);
    expect(a.messages[0]?.type).toBe("peer-assigned");
  });

  it("rejects a third connection", async () => {
    const stub = getStub("room-third-1");
    await stub.claim("room-third-1");
    await connect(stub);
    await connect(stub);
    const third = await connect(stub);
    expect(third.status).toBe(409);
  });

  it("gives slot 0 to whichever tab connects first, regardless of who created the room", async () => {
    const stub = getStub("room-arrival-order-1");
    await stub.claim("room-arrival-order-1");

    const invitee = await connect(stub); // connects first
    const creator = await connect(stub); // connects second
    await waitFor(() => invitee.messages.length >= 1 && creator.messages.length >= 1);

    expect(invitee.messages.find((m) => m.type === "peer-assigned")?.payload.slot).toBe(0);
    expect(creator.messages.find((m) => m.type === "peer-assigned")?.payload.slot).toBe(1);
  });

  it("sends byte-equivalent test-config to both peers even after a service change", async () => {
    const stub = getStub("room-config-1");
    await stub.claim("room-config-1");

    const a = await connect(stub);
    await waitFor(() => a.messages.length >= 2);

    setCurrentTestConfigForTesting({
      maxDurationMs: 999,
      maxBytes: 1,
      chunkBytes: 1,
    });

    const b = await connect(stub);
    await waitFor(() => b.messages.length >= 2);

    const aConfig = a.messages.find((m) => m.type === "test-config");
    const bConfig = b.messages.find((m) => m.type === "test-config");
    expect(bConfig?.payload).toEqual(aConfig?.payload);
    expect(bConfig?.payload).not.toEqual(getCurrentTestConfig());
  });

  it("broadcasts run-started with both peers ordered by slot when the second peer joins", async () => {
    const stub = getStub("room-run-started-1");
    await stub.claim("room-run-started-1");

    const a = await connect(stub);
    await waitFor(() => a.messages.length >= 2);
    const b = await connect(stub);
    await waitFor(
      () =>
        a.messages.some((m) => m.type === "run-started") &&
        b.messages.some((m) => m.type === "run-started"),
    );

    const aRunStarted = a.messages.find((m) => m.type === "run-started")!;
    const bRunStarted = b.messages.find((m) => m.type === "run-started")!;
    expect(aRunStarted.runId).toBe(bRunStarted.runId);
    expect(aRunStarted.payload.peers.map((p) => p.slot)).toEqual([0, 1]);

    const peerJoined = a.messages.find((m) => m.type === "peer-joined");
    expect(peerJoined?.payload.slot).toBe(1);
  });

  it("relays a message between two peers verbatim", async () => {
    const stub = getStub("room-relay-1");
    await stub.claim("room-relay-1");

    const a = await connect(stub);
    const b = await connect(stub);
    await waitFor(() => a.messages.some((m) => m.type === "run-started"));
    const runId = a.messages.find((m) => m.type === "run-started")!.runId as string;

    a.ws.send(
      JSON.stringify({ type: "ice-candidate", runId, payload: "hello from a" }),
    );
    await waitFor(() => b.messages.some((m) => m.type === "ice-candidate"));
    expect(b.messages.find((m) => m.type === "ice-candidate")?.payload).toBe(
      "hello from a",
    );
  });
});

describe("ice-servers issuance", () => {
  it("sends both peers a run-stamped ice-servers message once the run starts", async () => {
    const stub = getStub("room-ice-servers-1");
    await stub.claim("room-ice-servers-1");

    const a = await connect(stub);
    const b = await connect(stub);
    await waitFor(
      () =>
        a.messages.some((m) => m.type === "run-started") &&
        b.messages.some((m) => m.type === "run-started"),
    );
    const runId = a.messages.find((m) => m.type === "run-started")!.runId;

    await waitFor(
      () =>
        a.messages.some((m) => m.type === "ice-servers") &&
        b.messages.some((m) => m.type === "ice-servers"),
    );

    const aIce = a.messages.find((m) => m.type === "ice-servers")!;
    const bIce = b.messages.find((m) => m.type === "ice-servers")!;
    expect(aIce.runId).toBe(runId);
    expect(bIce.runId).toBe(runId);
    // No TURN secret is configured in the test environment, so the
    // provider adapter returns null and this exercises the STUN-only
    // fallback — same shape either way, just without the extra TURN entry.
    expect(aIce.payload.iceServers).toEqual([
      { urls: ["stun:stun.cloudflare.com:3478"] },
    ]);
    expect(bIce.payload.iceServers).toEqual(aIce.payload.iceServers);
  });

  it("a peer that waited well past a provider TTL before the second peer joins still gets ice-servers", async () => {
    const stub = getStub("room-ice-servers-late-1");
    await stub.claim("room-ice-servers-late-1");

    const a = await connect(stub, { autoPong: true });
    await waitFor(() => a.messages.some((m) => m.type === "peer-assigned"));
    // Long enough to have missed a heartbeat if `a` weren't auto-ponging —
    // proves a wait here has no bearing on credential freshness, since
    // credentials mint at run-started rather than at accept.
    await new Promise((r) => setTimeout(r, FAST_TIMING.heartbeatIntervalMs * 3));

    const b = await connect(stub);
    await waitFor(
      () =>
        a.messages.some((m) => m.type === "ice-servers") &&
        b.messages.some((m) => m.type === "ice-servers"),
    );
    expect(a.messages.some((m) => m.type === "ice-servers")).toBe(true);
  });

  it("ends the room as expired instead of starting a run when less than the TTL floor remains", async () => {
    setTimingForTesting({ turnCredentialFloorMs: 10_000 }); // >> hardExpiryMs
    const stub = getStub("room-ice-servers-floor-1");
    await stub.claim("room-ice-servers-floor-1");

    const a = await connect(stub);
    await waitFor(() => a.messages.some((m) => m.type === "peer-assigned"));
    const b = await connect(stub);

    await waitFor(() => a.messages.some((m) => m.type === "run-ended"));
    expect(a.messages.find((m) => m.type === "run-ended")?.payload.reason).toBe(
      "expired",
    );
    await waitFor(() => b.messages.some((m) => m.type === "run-ended"));
    expect(a.messages.some((m) => m.type === "run-started")).toBe(false);
    expect(a.messages.some((m) => m.type === "ice-servers")).toBe(false);
  });
});

describe("same-tab reconnect (refresh) does not pair with itself", () => {
  it("reclaims its own slot instead of taking the other one, even if the old socket is still technically attached", async () => {
    const stub = getStub("room-refresh-1");
    await stub.claim("room-refresh-1");

    const first = await connect(stub, { sessionId: "tab-A" });
    await waitFor(() => first.messages.some((m) => m.type === "peer-assigned"));
    expect(
      first.messages.find((m) => m.type === "peer-assigned")?.payload.slot,
    ).toBe(0);

    // Simulate a refresh: the new socket opens with the SAME session id
    // before the old one (`first`) has been closed or detected as gone.
    const refreshed = await connect(stub, { sessionId: "tab-A" });
    await waitFor(() =>
      refreshed.messages.some((m) => m.type === "peer-assigned"),
    );
    const reassigned = refreshed.messages.find((m) => m.type === "peer-assigned");
    expect(reassigned?.payload.slot).toBe(0); // same slot, not slot 1
    expect(reassigned?.payload.peerId).not.toBe(
      first.messages.find((m) => m.type === "peer-assigned")?.payload.peerId,
    );

    // No run-started should ever have fired — there was never a second peer.
    expect(refreshed.messages.some((m) => m.type === "run-started")).toBe(false);

    // A genuinely different tab still gets slot 1 normally.
    const guest = await connect(stub, { sessionId: "tab-B" });
    await waitFor(() => guest.messages.some((m) => m.type === "run-started"));
    expect(
      guest.messages.find((m) => m.type === "peer-assigned")?.payload.slot,
    ).toBe(1);
  });

  it("does not affect a genuinely different second peer connecting without a session id", async () => {
    const stub = getStub("room-refresh-2");
    await stub.claim("room-refresh-2");

    const a = await connect(stub, { sessionId: "tab-A" });
    await waitFor(() => a.messages.some((m) => m.type === "peer-assigned"));
    const b = await connect(stub); // no session id at all
    await waitFor(() => b.messages.some((m) => m.type === "run-started"));

    expect(a.messages.find((m) => m.type === "peer-assigned")?.payload.slot).toBe(0);
    expect(b.messages.find((m) => m.type === "peer-assigned")?.payload.slot).toBe(1);
  });
});

describe("hibernation-safe state", () => {
  it("rebuilds slot/peer state from getWebSockets + storage after an eviction", async () => {
    const stub = getStub("room-hibernate-1");
    await stub.claim("room-hibernate-1");

    const a = await connect(stub);
    await waitFor(() => a.messages.length >= 1);

    await evictDurableObject(stub);

    const b = await connect(stub);
    await waitFor(() => b.messages.some((m) => m.type === "peer-assigned"));
    expect(b.messages.find((m) => m.type === "peer-assigned")?.payload.slot).toBe(1);

    const c = await connect(stub);
    expect(c.status).toBe(409);
  });

  it("wakes on its own schedule after an eviction and marks a silent slot stale without any manual nudge", async () => {
    const stub = getStub("room-hibernate-heartbeat-1");
    await stub.claim("room-hibernate-heartbeat-1");

    await connect(stub); // never responds to pings from here on
    await evictDurableObject(stub);

    // Real elapsed time past 2x the heartbeat interval, with no call to
    // runDurableObjectAlarm and no new connection — only the DO's own
    // scheduled alarm, surviving the eviction, can produce this outcome.
    await waitFor(async () => {
      let heartbeatGone = false;
      await runInDurableObject(stub, async (_instance, state) => {
        heartbeatGone = (await state.storage.get("heartbeat:0")) === undefined;
      });
      return heartbeatGone;
    }, FAST_TIMING.heartbeatIntervalMs * 2 + 500);
  });
});

describe("stale slot replacement", () => {
  it("lets a new tab take over a stale solo slot before a run starts", async () => {
    const stub = getStub("room-stale-replace-1");
    await stub.claim("room-stale-replace-1");

    const a = await connect(stub);
    await waitFor(() => a.messages.length >= 1);
    const firstPeerId = a.messages.find((m) => m.type === "peer-assigned")?.payload
      .peerId;

    // Simulate a dead network: no clean close, just silence past the
    // heartbeat deadline (2x the interval).
    await new Promise((r) => setTimeout(r, FAST_TIMING.heartbeatIntervalMs * 2 + 20));
    await runDurableObjectAlarm(stub);

    const b = await connect(stub);
    await waitFor(() => b.messages.length >= 1);
    const secondAssigned = b.messages.find((m) => m.type === "peer-assigned");
    expect(secondAssigned?.payload.slot).toBe(0);
    expect(secondAssigned?.payload.peerId).not.toBe(firstPeerId);
  });

  it("replaces a stale slot 0 directly at connect time, without waiting for the alarm to run first", async () => {
    const stub = getStub("room-stale-fetch-time-1");
    await stub.claim("room-stale-fetch-time-1");

    const a = await connect(stub);
    await waitFor(() => a.messages.length >= 1);
    const firstPeerId = a.messages.find((m) => m.type === "peer-assigned")?.payload
      .peerId;

    // Past staleAt by real elapsed time, but the alarm has not run: slot 0's
    // socket is still technically attached. The fetch()-time staleness check
    // must reclaim it directly rather than falling through to slot 1.
    await new Promise((r) => setTimeout(r, FAST_TIMING.heartbeatIntervalMs * 2 + 20));

    const b = await connect(stub);
    await waitFor(() => b.messages.length >= 1);
    const secondAssigned = b.messages.find((m) => m.type === "peer-assigned");
    expect(secondAssigned?.payload.slot).toBe(0);
    expect(secondAssigned?.payload.peerId).not.toBe(firstPeerId);
  });

  it("gives a stale-slot replacement the same stored test-config as the socket it replaced", async () => {
    const stub = getStub("room-stale-replace-config-1");
    await stub.claim("room-stale-replace-config-1");

    const a = await connect(stub);
    await waitFor(() => a.messages.some((m) => m.type === "test-config"));
    const originalConfig = a.messages.find((m) => m.type === "test-config")?.payload;

    setCurrentTestConfigForTesting({
      maxDurationMs: 1,
      maxBytes: 1,
      chunkBytes: 1,
    });

    await new Promise((r) => setTimeout(r, FAST_TIMING.heartbeatIntervalMs * 2 + 20));
    await runDurableObjectAlarm(stub);

    const b = await connect(stub);
    await waitFor(() => b.messages.some((m) => m.type === "test-config"));
    const replacementConfig = b.messages.find((m) => m.type === "test-config")?.payload;

    expect(replacementConfig).toEqual(originalConfig);
    expect(replacementConfig).not.toEqual(getCurrentTestConfig());
  });

  it("never evicts a live, responsive peer via a third join attempt", async () => {
    const stub = getStub("room-live-not-evicted-1");
    await stub.claim("room-live-not-evicted-1");

    await connect(stub);
    await connect(stub); // fills both slots; run has started
    const third = await connect(stub);
    expect(third.status).toBe(409);
  });
});

describe("finish-ack lifecycle", () => {
  it("ends the room exactly once after both peers send run-finished", async () => {
    const stub = getStub("room-finish-1");
    await stub.claim("room-finish-1");

    const a = await connect(stub);
    const b = await connect(stub);
    await waitFor(() => a.messages.some((m) => m.type === "run-started"));
    const runId = a.messages.find((m) => m.type === "run-started")!.runId as string;

    a.ws.send(JSON.stringify({ type: "run-finished", runId, payload: {} }));
    a.ws.send(JSON.stringify({ type: "run-finished", runId, payload: {} })); // duplicate, no-op
    await new Promise((r) => setTimeout(r, 20));
    expect(a.messages.some((m) => m.type === "run-ended")).toBe(false);

    b.ws.send(JSON.stringify({ type: "run-finished", runId, payload: {} }));
    await waitFor(() => a.messages.some((m) => m.type === "run-ended"));

    const ended = a.messages.filter((m) => m.type === "run-ended");
    expect(ended).toHaveLength(1);
    expect(ended[0]?.payload.reason).toBe("complete");
  });

  it("emits finalization-timeout when only one peer finishes", async () => {
    const stub = getStub("room-finish-timeout-1");
    await stub.claim("room-finish-timeout-1");

    const a = await connect(stub);
    const b = await connect(stub);
    await waitFor(() => a.messages.some((m) => m.type === "run-started"));
    const runId = a.messages.find((m) => m.type === "run-started")!.runId as string;

    a.ws.send(JSON.stringify({ type: "run-finished", runId, payload: {} }));
    await new Promise((r) => setTimeout(r, 20)); // let the DO process the ack
    await new Promise((r) => setTimeout(r, FAST_TIMING.finalizationGraceMs + 20));
    await runDurableObjectAlarm(stub);

    expect(a.messages.some((m) => m.type === "run-ended")).toBe(true);
    expect(b.messages.some((m) => m.type === "run-ended")).toBe(true);
    const ended = a.messages.find((m) => m.type === "run-ended");
    expect(ended?.payload.reason).toBe("finalization-timeout");
  });
});

describe("terminal room", () => {
  it("rejects a fresh connection after the run has ended", async () => {
    const stub = getStub("room-terminal-1");
    await stub.claim("room-terminal-1");

    const a = await connect(stub);
    const b = await connect(stub);
    await waitFor(() => a.messages.some((m) => m.type === "run-started"));
    const runId = a.messages.find((m) => m.type === "run-started")!.runId as string;

    a.ws.send(JSON.stringify({ type: "run-finished", runId, payload: {} }));
    b.ws.send(JSON.stringify({ type: "run-finished", runId, payload: {} }));
    await waitFor(() => a.messages.some((m) => m.type === "run-ended"));

    const c = await connect(stub);
    expect(c.status).toBe(404);
  });
});

describe("hard expiry", () => {
  it("closes the room at expiresAt even while a peer keeps responding to heartbeats", async () => {
    const stub = getStub("room-expiry-1");
    await stub.claim("room-expiry-1");
    // autoPong keeps this peer "live" the whole time, so hard expiry — not
    // heartbeat staleness — is what ends the room: heartbeats must never be
    // able to extend the hard expiry.
    const a = await connect(stub, { autoPong: true });
    await waitFor(() => a.messages.length >= 1);

    await new Promise((r) => setTimeout(r, FAST_TIMING.hardExpiryMs + 20));
    await runDurableObjectAlarm(stub);

    await waitFor(() => a.messages.some((m) => m.type === "run-ended"));
    expect(a.messages.find((m) => m.type === "run-ended")?.payload.reason).toBe(
      "expired",
    );

    const after = await connect(stub);
    expect(after.status).toBe(404);
  });
});

describe("idle and never-opened cleanup", () => {
  it("cleans up a room that was claimed but never opened", async () => {
    const stub = getStub("room-never-opened-1");
    await stub.claim("room-never-opened-1");

    await new Promise((r) => setTimeout(r, FAST_TIMING.idleWindowMs + 20));
    await runDurableObjectAlarm(stub);

    expect(await stub.claim("room-never-opened-1")).toBe(true); // claimed flag is gone
  });
});

describe("storage contains no peer data", () => {
  it("only ever stores room/slot/run/test-parameter fields", async () => {
    const stub = getStub("room-storage-1");
    await stub.claim("room-storage-1");
    await connect(stub);
    await connect(stub);

    await runInDurableObject(stub, async (_instance, state) => {
      const list = await state.storage.list();
      const allowedKeys =
        /^(claimed|slug|expiresAt|lastActivityAt|runId|terminal|testConfig|finish:[01]|finishDeadline|heartbeat:[01])$/;
      for (const key of list.keys()) {
        expect(key).toMatch(allowedKeys);
      }
    });
  });
});
