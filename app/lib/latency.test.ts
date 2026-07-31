import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LatencyAggregate,
  LiveLatency,
  Sample,
} from "~/model/measurement.model";
import type { LatencyMessage } from "~/model/control-message.model";
import { decodeControlMessage } from "./control-message";
import { aggregateSamples, LatencySession, type LatencyHandoff } from "./latency";

/** These sessions only ever emit the four latency types; narrowing keeps the
 * relay honest rather than casting. */
function asLatencyMessage(raw: unknown, runId: string): LatencyMessage | null {
  const msg = decodeControlMessage(raw, runId);
  if (!msg) return null;
  switch (msg.type) {
    case "channel-ready":
    case "ping":
    case "pong":
    case "latency-ready":
      return msg;
    default:
      return null;
  }
}

const RUN_ID = "run-1";

describe("aggregateSamples", () => {
  it("returns null with fewer than 3 samples", () => {
    expect(aggregateSamples([])).toBeNull();
    expect(aggregateSamples([{ seq: 0, rttMs: 10 }])).toBeNull();
    expect(
      aggregateSamples([
        { seq: 0, rttMs: 10 },
        { seq: 1, rttMs: 20 },
      ]),
    ).toBeNull();
  });

  it("computes the median RTT and mean-absolute-difference jitter", () => {
    const samples: Sample[] = [
      { seq: 0, rttMs: 10 },
      { seq: 1, rttMs: 20 },
      { seq: 2, rttMs: 15 },
      { seq: 3, rttMs: 30 },
    ];
    // sorted: 10, 15, 20, 30 -> median (15+20)/2 = 17.5
    // arrival-order diffs: |20-10|=10, |15-20|=5, |30-15|=15 -> mean 10
    expect(aggregateSamples(samples)).toEqual({ rttMs: 17.5, jitterMs: 10 });
  });

  it("jitter reflects arrival order, not sorted order", () => {
    const ascending: Sample[] = [
      { seq: 0, rttMs: 10 },
      { seq: 1, rttMs: 12 },
      { seq: 2, rttMs: 14 },
    ];
    const shuffled: Sample[] = [
      { seq: 0, rttMs: 14 },
      { seq: 1, rttMs: 10 },
      { seq: 2, rttMs: 12 },
    ];
    expect(aggregateSamples(ascending)?.jitterMs).toBe(2);
    expect(aggregateSamples(shuffled)?.jitterMs).toBe(3);
  });
});

describe("LatencySession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("echoes a pong for every received ping regardless of local session state", () => {
    const sent: LatencyMessage[] = [];
    const session = new LatencySession({
      runId: RUN_ID,
      send: (raw) => sent.push(JSON.parse(raw)),
    });
    session.handleMessage({ runId: RUN_ID, type: "ping", seq: 7, payload: {} });
    expect(sent).toEqual([{ runId: RUN_ID, type: "pong", seq: 7, payload: {} }]);
  });

  it("does not start sampling until both a sent and a received channel-ready are present, regardless of order", () => {
    const started: true[] = [];
    const session = new LatencySession({
      runId: RUN_ID,
      send: () => {},
      callbacks: { onSamplingStarted: () => started.push(true) },
    });
    session.handleMessage({ runId: RUN_ID, type: "channel-ready", payload: {} });
    expect(started).toEqual([]);
    session.sendChannelReady();
    expect(started).toEqual([true]);
  });

  it("computes RTT from the local clock across a single matched round trip", () => {
    vi.setSystemTime(0);
    const sentRaws: string[] = [];
    const live: LiveLatency[] = [];
    const session = new LatencySession({
      runId: RUN_ID,
      send: (raw) => sentRaws.push(raw),
      callbacks: { onLive: (l) => live.push(l) },
    });

    session.handleMessage({ runId: RUN_ID, type: "channel-ready", payload: {} });
    session.sendChannelReady(); // starts sampling and sends ping seq 0 synchronously

    const ping = decodeControlMessage(sentRaws[1], RUN_ID); // sentRaws[0] is our own channel-ready
    expect(ping).toEqual({ runId: RUN_ID, type: "ping", seq: 0, payload: {} });

    vi.setSystemTime(37);
    session.handleMessage({ runId: RUN_ID, type: "pong", seq: 0, payload: {} });

    expect(live).toEqual([{ rttMs: 37, jitterMs: null, sampleCount: 1 }]);
  });

  it("ignores an unmatched, duplicate, or already-retired pong rather than counting it", () => {
    const live: LiveLatency[] = [];
    const session = new LatencySession({
      runId: RUN_ID,
      send: () => {},
      callbacks: { onLive: (l) => live.push(l) },
    });
    session.handleMessage({ runId: RUN_ID, type: "channel-ready", payload: {} });
    session.sendChannelReady();

    session.handleMessage({ runId: RUN_ID, type: "pong", seq: 99, payload: {} }); // never sent
    expect(live).toEqual([]);

    session.handleMessage({ runId: RUN_ID, type: "pong", seq: 0, payload: {} });
    expect(live).toHaveLength(1);

    session.handleMessage({ runId: RUN_ID, type: "pong", seq: 0, payload: {} }); // duplicate
    expect(live).toHaveLength(1);
  });

  it("retires a ping whose pong never arrives within the per-ping timeout, discarding a late reply", () => {
    const live: LiveLatency[] = [];
    const session = new LatencySession({
      runId: RUN_ID,
      send: () => {},
      callbacks: { onLive: (l) => live.push(l) },
    });
    session.handleMessage({ runId: RUN_ID, type: "channel-ready", payload: {} });
    session.sendChannelReady(); // ping seq 0 sent at t=0

    vi.advanceTimersByTime(2001); // past the 2s per-ping timeout
    session.handleMessage({ runId: RUN_ID, type: "pong", seq: 0, payload: {} }); // arrives late
    expect(live).toEqual([]);
  });

  function createLinkedSessions(
    runId: string,
    dropPredicate?: (raw: string, from: "a" | "b") => boolean,
  ) {
    let sessionA!: LatencySession;
    let sessionB!: LatencySession;
    const liveA: LiveLatency[] = [];
    const liveB: LiveLatency[] = [];
    const handoffA: LatencyHandoff[] = [];
    const handoffB: LatencyHandoff[] = [];

    sessionA = new LatencySession({
      runId,
      send: (raw) => {
        if (dropPredicate?.(raw, "a")) return;
        const msg = asLatencyMessage(raw, runId);
        if (msg) sessionB.handleMessage(msg);
      },
      callbacks: { onLive: (l) => liveA.push(l), onHandoff: (h) => handoffA.push(h) },
    });
    sessionB = new LatencySession({
      runId,
      send: (raw) => {
        if (dropPredicate?.(raw, "b")) return;
        const msg = asLatencyMessage(raw, runId);
        if (msg) sessionA.handleMessage(msg);
      },
      callbacks: { onLive: (l) => liveB.push(l), onHandoff: (h) => handoffB.push(h) },
    });

    return { sessionA, sessionB, liveA, liveB, handoffA, handoffB };
  }

  it("runs the two-sided barrier then the full symmetric protocol to matching completion", () => {
    const { sessionA, sessionB, handoffA, handoffB, liveA } = createLinkedSessions(RUN_ID);

    sessionA.sendChannelReady();
    expect(liveA).toEqual([]); // B hasn't reciprocated yet — no ping sent

    sessionB.sendChannelReady(); // completes the barrier on both sides synchronously

    vi.advanceTimersByTime(2500); // comfortably past 10 samples at 200ms cadence

    expect(handoffA).toHaveLength(1);
    expect(handoffB).toHaveLength(1);
    expect(handoffA[0]).toEqual({ kind: "ready", baseline: { rttMs: 0, jitterMs: 0 } });
    expect(handoffB[0]).toEqual({ kind: "ready", baseline: { rttMs: 0, jitterMs: 0 } });
    expect(liveA[liveA.length - 1].sampleCount).toBe(10);
  });

  it("closes on the deadline with a usable aggregate when loss prevents reaching the target count", () => {
    const dropPongFromSeq = (threshold: number) => (raw: string) => {
      const msg = JSON.parse(raw) as { type: string; seq?: number };
      return msg.type === "pong" && typeof msg.seq === "number" && msg.seq >= threshold;
    };

    const { sessionA, sessionB, handoffA, handoffB } = createLinkedSessions(
      RUN_ID,
      dropPongFromSeq(4),
    );

    sessionA.sendChannelReady();
    sessionB.sendChannelReady();

    vi.advanceTimersByTime(5100); // past the 5s window deadline — 10 is never reached

    expect(handoffA).toHaveLength(1);
    expect(handoffB).toHaveLength(1);
    // Exactly 4 samples (seq 0-3) matched before pongs started being dropped
    // — at least MIN_SAMPLES, so a real aggregate comes out rather than null.
    expect(handoffA[0]).toEqual({ kind: "ready", baseline: { rttMs: 0, jitterMs: 0 } });
    expect(handoffB[0]).toEqual({ kind: "ready", baseline: { rttMs: 0, jitterMs: 0 } });
  });

  describe("freezeForTerminal", () => {
    it("is a no-op before sampling starts — no measurement boundary was crossed", () => {
      const handoffs: LatencyHandoff[] = [];
      const session = new LatencySession({
        runId: RUN_ID,
        send: () => {},
        callbacks: { onHandoff: (h) => handoffs.push(h) },
      });
      session.freezeForTerminal("run-ended");
      expect(handoffs).toEqual([]);
    });

    it("snapshots whatever samples arrived, honors the minimum-sample rule, and fires exactly once", () => {
      const handoffs: LatencyHandoff[] = [];
      const session = new LatencySession({
        runId: RUN_ID,
        send: () => {},
        callbacks: { onHandoff: (h) => handoffs.push(h) },
      });

      session.handleMessage({ runId: RUN_ID, type: "channel-ready", payload: {} });
      session.sendChannelReady(); // sends ping seq 0

      session.handleMessage({ runId: RUN_ID, type: "pong", seq: 0, payload: {} });
      vi.advanceTimersByTime(200); // ping seq 1 sent
      session.handleMessage({ runId: RUN_ID, type: "pong", seq: 1, payload: {} });
      vi.advanceTimersByTime(200); // ping seq 2 sent
      session.handleMessage({ runId: RUN_ID, type: "pong", seq: 2, payload: {} });

      session.freezeForTerminal("run-ended");
      session.freezeForTerminal("control-closed"); // second call must be a no-op

      expect(handoffs).toEqual([
        { kind: "terminal", reason: "run-ended", baseline: { rttMs: 0, jitterMs: 0 }, sampleCount: 3 },
      ]);
    });

    it("reports an honest null baseline with the real sample count under the minimum", () => {
      const handoffs: LatencyHandoff[] = [];
      const session = new LatencySession({
        runId: RUN_ID,
        send: () => {},
        callbacks: { onHandoff: (h) => handoffs.push(h) },
      });
      session.handleMessage({ runId: RUN_ID, type: "channel-ready", payload: {} });
      session.sendChannelReady();
      session.handleMessage({ runId: RUN_ID, type: "pong", seq: 0, payload: {} });

      session.freezeForTerminal("control-closed");
      expect(handoffs).toEqual([
        { kind: "terminal", reason: "control-closed", baseline: null, sampleCount: 1 },
      ]);
    });
  });

  it("reset clears all state back to idle, allowing sampling to start again", () => {
    const started: true[] = [];
    const session = new LatencySession({
      runId: RUN_ID,
      send: () => {},
      callbacks: { onSamplingStarted: () => started.push(true) },
    });
    session.handleMessage({ runId: RUN_ID, type: "channel-ready", payload: {} });
    session.sendChannelReady();
    expect(started).toEqual([true]);

    session.reset();
    session.handleMessage({ runId: RUN_ID, type: "channel-ready", payload: {} });
    session.sendChannelReady();
    expect(started).toEqual([true, true]);
  });
});
