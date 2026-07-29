import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeLatencyMessage } from "./latency";
import { parseBulkFrame, type BulkChannel } from "./throughput";
import {
  StageOrchestrator,
  TerminalController,
  decodeStageMessage,
  type ResultSharePayload,
  type StageMessage,
  type TerminalPeerInfo,
} from "./control-channel";
import type { StageBankEntry } from "./stage";

const RUN_ID = "11111111-2222-4333-8444-555555555555";

describe("decodeStageMessage", () => {
  it("round-trips stage-prepare/armed/start", () => {
    for (const type of ["stage-prepare", "stage-armed", "stage-start"] as const) {
      expect(
        decodeStageMessage(JSON.stringify({ runId: RUN_ID, type, stageId: 1, payload: {} }), RUN_ID),
      ).toEqual({ runId: RUN_ID, type, stageId: 1, payload: {} });
    }
  });

  it("round-trips stage-complete with and without sentMeasuredChunks", () => {
    expect(
      decodeStageMessage(
        JSON.stringify({ runId: RUN_ID, type: "stage-complete", stageId: 0, payload: { sentMeasuredChunks: 42 } }),
        RUN_ID,
      ),
    ).toEqual({ runId: RUN_ID, type: "stage-complete", stageId: 0, payload: { sentMeasuredChunks: 42 } });

    expect(
      decodeStageMessage(
        JSON.stringify({ runId: RUN_ID, type: "stage-complete", stageId: 0, payload: {} }),
        RUN_ID,
      ),
    ).toEqual({ runId: RUN_ID, type: "stage-complete", stageId: 0, payload: { sentMeasuredChunks: undefined } });
  });

  it("round-trips measurement-progress", () => {
    const msg = {
      runId: RUN_ID,
      type: "measurement-progress",
      stageId: 2,
      receiverSlot: 1,
      progressSeq: 3,
      payload: { elapsedMs: 100, bytes: 5000, chunksSeen: 4, highestSeqPlusOne: 5 },
    };
    expect(decodeStageMessage(JSON.stringify(msg), RUN_ID)).toEqual(msg);
  });

  it("round-trips stage-result and stage-result-ack", () => {
    const measurement = { bytes: 1000, durationMs: 100, latency: 10, jitter: 1, chunksSeen: 5, chunksExpected: 5 };
    expect(
      decodeStageMessage(
        JSON.stringify({ runId: RUN_ID, type: "stage-result", stageId: 0, receiverSlot: 1, payload: { measurement } }),
        RUN_ID,
      ),
    ).toEqual({ runId: RUN_ID, type: "stage-result", stageId: 0, receiverSlot: 1, payload: { measurement } });

    expect(
      decodeStageMessage(
        JSON.stringify({ runId: RUN_ID, type: "stage-result-ack", stageId: 0, receiverSlot: 1, payload: {} }),
        RUN_ID,
      ),
    ).toEqual({ runId: RUN_ID, type: "stage-result-ack", stageId: 0, receiverSlot: 1, payload: {} });
  });

  it("rejects a stage-result with an invalid measurement (chunksSeen > chunksExpected)", () => {
    const measurement = { bytes: 1000, durationMs: 100, latency: 10, jitter: 1, chunksSeen: 6, chunksExpected: 5 };
    expect(
      decodeStageMessage(
        JSON.stringify({ runId: RUN_ID, type: "stage-result", stageId: 0, receiverSlot: 1, payload: { measurement } }),
        RUN_ID,
      ),
    ).toBeNull();
  });

  it("rejects an unknown stageId or receiverSlot", () => {
    expect(
      decodeStageMessage(JSON.stringify({ runId: RUN_ID, type: "stage-prepare", stageId: 5, payload: {} }), RUN_ID),
    ).toBeNull();
    expect(
      decodeStageMessage(
        JSON.stringify({ runId: RUN_ID, type: "stage-result-ack", stageId: 0, receiverSlot: 2, payload: {} }),
        RUN_ID,
      ),
    ).toBeNull();
  });

  it("round-trips test-abort", () => {
    expect(
      decodeStageMessage(
        JSON.stringify({ runId: RUN_ID, type: "test-abort", payload: { status: "CANCELED", reason: "user-canceled" } }),
        RUN_ID,
      ),
    ).toEqual({ runId: RUN_ID, type: "test-abort", payload: { status: "CANCELED", reason: "user-canceled" } });
  });

  it("rejects test-abort with an empty reason or bad status", () => {
    expect(
      decodeStageMessage(
        JSON.stringify({ runId: RUN_ID, type: "test-abort", payload: { status: "CANCELED", reason: "" } }),
        RUN_ID,
      ),
    ).toBeNull();
    expect(
      decodeStageMessage(
        JSON.stringify({ runId: RUN_ID, type: "test-abort", payload: { status: "SUCCEED", reason: "x" } }),
        RUN_ID,
      ),
    ).toBeNull();
  });

  it("round-trips a SUCCEED result-share", () => {
    const measurement = { bytes: 1, durationMs: 1, latency: 1, jitter: 1, chunksSeen: 1, chunksExpected: 1 };
    const msg = {
      runId: RUN_ID,
      type: "result-share",
      payload: { status: "SUCCEED", directional: measurement, duplex: measurement, via: "DIRECT" },
    };
    expect(decodeStageMessage(JSON.stringify(msg), RUN_ID)).toEqual(msg);
  });

  it("round-trips a FAILED result-share with partial measurements", () => {
    const measurement = { bytes: 1, durationMs: 1, latency: 1, jitter: 1, chunksSeen: 1, chunksExpected: 1 };
    const msg = {
      runId: RUN_ID,
      type: "result-share",
      payload: { status: "FAILED", reason: "peer-left", directional: measurement },
    };
    expect(decodeStageMessage(JSON.stringify(msg), RUN_ID)).toEqual(msg);
  });

  it("rejects a SUCCEED result-share missing directional/duplex/via", () => {
    expect(
      decodeStageMessage(
        JSON.stringify({ runId: RUN_ID, type: "result-share", payload: { status: "SUCCEED" } }),
        RUN_ID,
      ),
    ).toBeNull();
  });

  it("rejects a stale or foreign runId", () => {
    expect(
      decodeStageMessage(
        JSON.stringify({ runId: "other-run", type: "stage-prepare", stageId: 0, payload: {} }),
        RUN_ID,
      ),
    ).toBeNull();
  });

  it("rejects a type outside the whole control vocabulary and Phase 3's own types", () => {
    expect(decodeStageMessage(JSON.stringify({ runId: RUN_ID, type: "banana", payload: {} }), RUN_ID)).toBeNull();
    expect(
      decodeStageMessage(JSON.stringify({ runId: RUN_ID, type: "ping", seq: 0, payload: {} }), RUN_ID),
    ).toBeNull();
  });
});

// --- Two-peer integration harness -------------------------------------

class RelayChannel implements BulkChannel {
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onFrame: ((data: ArrayBuffer) => void) | null = null;
  private listeners: Array<() => void> = [];

  send(data: ArrayBuffer): void {
    this.bufferedAmount += data.byteLength;
    this.onFrame?.(data);
  }
  addEventListener(_type: "bufferedamountlow", listener: () => void): void {
    this.listeners.push(listener);
  }
  removeEventListener(_type: "bufferedamountlow", listener: () => void): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }
  drain(): void {
    this.bufferedAmount = 0;
    for (const l of [...this.listeners]) l();
  }
}

function linkControl(
  runId: string,
  getTarget: () => { handlePing(seq: number): void; handlePong(seq: number): void; handleMessage(msg: StageMessage): void },
): (raw: string) => void {
  return (raw: string) => {
    const latencyMsg = decodeLatencyMessage(raw, runId);
    if (latencyMsg) {
      if (latencyMsg.type === "ping") getTarget().handlePing(latencyMsg.seq);
      else if (latencyMsg.type === "pong") getTarget().handlePong(latencyMsg.seq);
      return;
    }
    const stageMsg = decodeStageMessage(raw, runId);
    if (stageMsg) getTarget().handleMessage(stageMsg);
  };
}

function advance(channels: RelayChannel[], totalMs: number, stepMs = 50): void {
  const steps = Math.ceil(totalMs / stepMs);
  for (let i = 0; i < steps; i++) {
    vi.advanceTimersByTime(stepMs);
    for (const c of channels) c.drain();
  }
}

describe("StageOrchestrator (two linked peers)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function setup(testConfig = { maxDurationMs: 300, maxBytes: 20_000, chunkBytes: 1000 }) {
    const bulkA = new RelayChannel();
    const bulkB = new RelayChannel();

    let orchA!: StageOrchestrator;
    let orchB!: StageOrchestrator;

    const bankedA: StageBankEntry[] = [];
    const bankedB: StageBankEntry[] = [];
    let doneA = false;
    let doneB = false;
    let timeoutA = false;
    let timeoutB = false;

    orchA = new StageOrchestrator({
      runId: RUN_ID,
      selfSlot: 0,
      testConfig,
      send: linkControl(RUN_ID, () => orchB),
      bulkChannel: bulkA,
      callbacks: {
        onEdgeBanked: (e) => bankedA.push(e),
        onStagesDone: () => (doneA = true),
        onTimeout: () => (timeoutA = true),
      },
    });
    orchB = new StageOrchestrator({
      runId: RUN_ID,
      selfSlot: 1,
      testConfig,
      send: linkControl(RUN_ID, () => orchA),
      bulkChannel: bulkB,
      callbacks: {
        onEdgeBanked: (e) => bankedB.push(e),
        onStagesDone: () => (doneB = true),
        onTimeout: () => (timeoutB = true),
      },
    });

    bulkA.onFrame = (data) => orchB.handleBulkFrame(parseBulkFrame(data)!);
    bulkB.onFrame = (data) => orchA.handleBulkFrame(parseBulkFrame(data)!);

    return {
      orchA,
      orchB,
      bulkA,
      bulkB,
      bankedA,
      bankedB,
      get doneA() {
        return doneA;
      },
      get doneB() {
        return doneB;
      },
      get timeoutA() {
        return timeoutA;
      },
      get timeoutB() {
        return timeoutB;
      },
    };
  }

  it("runs download, upload, and duplex to completion with a symmetric 4-edge bank on both peers", () => {
    vi.setSystemTime(0);
    const t = setup();
    t.orchA.start();
    t.orchB.start();

    advance([t.bulkA, t.bulkB], 15_000, 25);

    expect(t.doneA).toBe(true);
    expect(t.doneB).toBe(true);
    expect(t.bankedA).toHaveLength(4);
    expect(t.bankedB).toHaveLength(4);

    const keysA = new Set(t.orchA.getBank().map((e) => `${e.stageId}:${e.receiverSlot}`));
    const keysB = new Set(t.orchB.getBank().map((e) => `${e.stageId}:${e.receiverSlot}`));
    expect(keysA).toEqual(new Set(["0:1", "1:0", "2:0", "2:1"]));
    expect(keysB).toEqual(keysA);

    // Every banked edge has a real, positive throughput window.
    for (const e of t.orchA.getBank()) {
      expect(e.measurement.chunksExpected).toBeGreaterThan(0);
      expect(e.measurement.chunksSeen).toBeGreaterThan(0);
      expect(e.measurement.bytes).toBeGreaterThan(0);
    }
  });

  it("stage roles follow slot number: download is banked under receiverSlot 1, upload under 0", () => {
    vi.setSystemTime(0);
    const t = setup();
    t.orchA.start();
    t.orchB.start();
    advance([t.bulkA, t.bulkB], 15_000, 25);

    const download = t.orchA.getBank().find((e) => e.stageId === 0)!;
    const upload = t.orchA.getBank().find((e) => e.stageId === 1)!;
    expect(download.receiverSlot).toBe(1);
    expect(upload.receiverSlot).toBe(0);
  });

  it("banked edges are byte-identical between both peers for the same key", () => {
    vi.setSystemTime(0);
    const t = setup();
    t.orchA.start();
    t.orchB.start();
    advance([t.bulkA, t.bulkB], 15_000, 25);

    for (const entry of t.orchA.getBank()) {
      const match = t.orchB
        .getBank()
        .find((e) => e.stageId === entry.stageId && e.receiverSlot === entry.receiverSlot)!;
      expect(match.measurement).toEqual(entry.measurement);
    }
  });

  it("times out and never fires onStagesDone if the peer's stage-armed never arrives", () => {
    vi.setSystemTime(0);
    const testConfig = { maxDurationMs: 300, maxBytes: 20_000, chunkBytes: 1000 };
    const bulkA = new RelayChannel();
    let timeoutA = false;
    let doneA = false;
    const orchA = new StageOrchestrator({
      runId: RUN_ID,
      selfSlot: 0,
      testConfig,
      send: () => {}, // every outbound message from A vanishes — no peer ever responds
      bulkChannel: bulkA,
      callbacks: { onTimeout: () => (timeoutA = true), onStagesDone: () => (doneA = true) },
    });

    orchA.start(); // sends stage-prepare into the void, then waits for stage-armed forever
    advance([bulkA], 20_000, 200);

    expect(doneA).toBe(false);
    expect(timeoutA).toBe(true);
    expect(orchA.getBank()).toHaveLength(0);
  });
});

describe("TerminalController (two linked peers)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const PEER_A_ID = "3f29a1c4-5e6b-5a2d-9f3e-1b7c8d4a2e10";
  const PEER_B_ID = "8a4d2b91-7c3e-5f1a-b6d8-2e9f4c7a1b35";
  const ROOM = "4G7QZKX9M";
  const TIMESTAMP = "2026-07-29T14:32:07Z";

  const measurement = (n: number) => ({
    bytes: 1_000_000 + n,
    durationMs: 1000,
    latency: 10,
    jitter: 1,
    chunksSeen: 100,
    chunksExpected: 100,
  });

  function fullBank(): StageBankEntry[] {
    return [
      { stageId: 0, receiverSlot: 1, measurement: measurement(1) },
      { stageId: 1, receiverSlot: 0, measurement: measurement(2) },
      { stageId: 2, receiverSlot: 0, measurement: measurement(3) },
      { stageId: 2, receiverSlot: 1, measurement: measurement(4) },
    ];
  }

  function peers(): [TerminalPeerInfo, TerminalPeerInfo] {
    return [
      { slot: 0, peerId: PEER_A_ID, profile: { name: "Peer A" } },
      { slot: 1, peerId: PEER_B_ID, profile: { name: "Peer B" } },
    ];
  }

  function link(
    a: TerminalController,
    b: TerminalController,
  ): { sendA: (raw: string) => void; sendB: (raw: string) => void } {
    const route = (target: TerminalController) => (raw: string) => {
      const msg = decodeStageMessage(raw, RUN_ID);
      if (!msg) return;
      if (msg.type === "result-share") target.handleResultShare(msg.payload as ResultSharePayload);
      // test-abort is applied by the test directly via trigger(), matching
      // how room.tsx would route an incoming test-abort into trigger().
    };
    return { sendA: route(b), sendB: route(a) };
  }

  it("SUCCEED + SUCCEED assembles a byte-identical, SUCCEED record on both sides", async () => {
    let a!: TerminalController;
    let b!: TerminalController;
    a = new TerminalController({
      runId: RUN_ID,
      room: ROOM,
      timestamp: TIMESTAMP,
      selfSlot: 0,
      selfPeerId: PEER_A_ID,
      send: (raw) => routes.sendA(raw),
      freezeStages: () => fullBank(),
      getConnectionType: () => "DIRECT",
      getPeers: peers,
    });
    b = new TerminalController({
      runId: RUN_ID,
      room: ROOM,
      timestamp: TIMESTAMP,
      selfSlot: 1,
      selfPeerId: PEER_B_ID,
      send: (raw) => routes.sendB(raw),
      freezeStages: () => fullBank(),
      getConnectionType: () => "DIRECT",
      getPeers: peers,
    });
    const routes = link(a, b);

    const [outcomeA, outcomeB] = await Promise.all([a.trigger({ kind: "clean" }), b.trigger({ kind: "clean" })]);

    expect(outcomeA.status).toBe("SUCCEED");
    expect(outcomeB.status).toBe("SUCCEED");
    expect(outcomeA.validation?.valid).toBe(true);
    expect(outcomeB.validation?.valid).toBe(true);
    expect(outcomeA.record?.data).toEqual(outcomeB.record?.data);
    expect(outcomeA.record?.metadata.hash).toBe(outcomeB.record?.metadata.hash);
    expect(outcomeA.record?.metadata["peer-id"]).toBe(PEER_A_ID);
    expect(outcomeB.record?.metadata["peer-id"]).toBe(PEER_B_ID);
  });

  it("one FAILED trigger forces both records to FAILED (FAILED outranks SUCCEED)", async () => {
    let a!: TerminalController;
    let b!: TerminalController;
    a = new TerminalController({
      runId: RUN_ID,
      room: ROOM,
      timestamp: TIMESTAMP,
      selfSlot: 0,
      selfPeerId: PEER_A_ID,
      send: (raw) => routes.sendA(raw),
      freezeStages: () => fullBank(),
      getConnectionType: () => "DIRECT",
      getPeers: peers,
    });
    b = new TerminalController({
      runId: RUN_ID,
      room: ROOM,
      timestamp: TIMESTAMP,
      selfSlot: 1,
      selfPeerId: PEER_B_ID,
      send: (raw) => routes.sendB(raw),
      freezeStages: () => fullBank(),
      getConnectionType: () => "DIRECT",
      getPeers: peers,
    });
    const routes = link(a, b);

    const [outcomeA, outcomeB] = await Promise.all([
      a.trigger({ kind: "local-abort", status: "FAILED", reason: "ice-failed" }),
      b.trigger({ kind: "clean" }),
    ]);

    expect(outcomeA.status).toBe("FAILED");
    expect(outcomeB.status).toBe("FAILED");
  });

  it("a missing peer share forces this record to FAILED after the wait deadline", async () => {
    const a = new TerminalController({
      runId: RUN_ID,
      room: ROOM,
      timestamp: TIMESTAMP,
      selfSlot: 0,
      selfPeerId: PEER_A_ID,
      send: () => {}, // peer never receives anything
      freezeStages: () => fullBank(),
      getConnectionType: () => "DIRECT",
      getPeers: peers,
    });

    const promise = a.trigger({ kind: "clean" });
    await vi.advanceTimersByTimeAsync(5_000);
    const outcome = await promise;

    expect(outcome.status).toBe("FAILED");
    expect(outcome.record?.data.status).toBe("FAILED");
  });

  it("RELAY wins the via combination if either side reports it", async () => {
    let a!: TerminalController;
    let b!: TerminalController;
    a = new TerminalController({
      runId: RUN_ID,
      room: ROOM,
      timestamp: TIMESTAMP,
      selfSlot: 0,
      selfPeerId: PEER_A_ID,
      send: (raw) => routes.sendA(raw),
      freezeStages: () => fullBank(),
      getConnectionType: () => "RELAY",
      getPeers: peers,
    });
    b = new TerminalController({
      runId: RUN_ID,
      room: ROOM,
      timestamp: TIMESTAMP,
      selfSlot: 1,
      selfPeerId: PEER_B_ID,
      send: (raw) => routes.sendB(raw),
      freezeStages: () => fullBank(),
      getConnectionType: () => "DIRECT",
      getPeers: peers,
    });
    const routes = link(a, b);

    const [outcomeA, outcomeB] = await Promise.all([a.trigger({ kind: "clean" }), b.trigger({ kind: "clean" })]);
    expect(outcomeA.record?.data.via).toBe("RELAY");
    expect(outcomeB.record?.data.via).toBe("RELAY");
  });

  it("is idempotent: a second trigger call joins the same outcome", async () => {
    const a = new TerminalController({
      runId: RUN_ID,
      room: ROOM,
      timestamp: TIMESTAMP,
      selfSlot: 0,
      selfPeerId: PEER_A_ID,
      send: () => {},
      freezeStages: () => fullBank(),
      getConnectionType: () => "DIRECT",
      getPeers: peers,
    });
    const p1 = a.trigger({ kind: "clean" });
    const p2 = a.trigger({ kind: "local-abort", status: "CANCELED", reason: "user-canceled" });
    await vi.advanceTimersByTimeAsync(5_000);
    const [o1, o2] = await Promise.all([p1, p2]);
    expect(o1).toBe(o2); // same promise/object identity
    // CANCELED still escalates the outcome even though it arrived after "clean".
    expect(o1.status).toBe("FAILED"); // no peer share ever arrives -> forced FAILED regardless
  });
});
