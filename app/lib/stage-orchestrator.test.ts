import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BulkChannel } from "~/model/bulk-frame.model";
import type { StageMessage } from "~/model/control-message.model";
import { decodeControlMessage } from "./control-message";
import { parseBulkFrame } from "./throughput";

const RUN_ID = "11111111-2222-4333-8444-555555555555";

import type { StageBankEntry } from "~/model/measurement.model";
import { StageOrchestrator } from "./stage-orchestrator";

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
    const msg = decodeControlMessage(raw, runId);
    if (!msg) return;
    if (msg.type === "ping") getTarget().handlePing(msg.seq);
    else if (msg.type === "pong") getTarget().handlePong(msg.seq);
    else if (msg.type !== "channel-ready" && msg.type !== "latency-ready" && msg.type !== "peer-profile") {
      getTarget().handleMessage(msg);
    }
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

  const TEST_BULK_CHANNEL_COUNT = 3;

  function setup(testConfig = { maxDurationMs: 300, maxBytes: 20_000, chunkBytes: 1000 }) {
    const bulkA = Array.from({ length: TEST_BULK_CHANNEL_COUNT }, () => new RelayChannel());
    const bulkB = Array.from({ length: TEST_BULK_CHANNEL_COUNT }, () => new RelayChannel());

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
      bulkChannels: bulkA,
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
      bulkChannels: bulkB,
      callbacks: {
        onEdgeBanked: (e) => bankedB.push(e),
        onStagesDone: () => (doneB = true),
        onTimeout: () => (timeoutB = true),
      },
    });

    // Same-index channels are wired to each other, matching how webrtc.ts
    // pairs "bulk-N" on one side with "bulk-N" on the other.
    bulkA.forEach((c) => (c.onFrame = (data) => orchB.handleBulkFrame(parseBulkFrame(data)!)));
    bulkB.forEach((c) => (c.onFrame = (data) => orchA.handleBulkFrame(parseBulkFrame(data)!)));

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

    advance([...t.bulkA, ...t.bulkB], 15_000, 200);

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
    advance([...t.bulkA, ...t.bulkB], 15_000, 200);

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
    advance([...t.bulkA, ...t.bulkB], 15_000, 200);

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
      bulkChannels: [bulkA],
      callbacks: { onTimeout: () => (timeoutA = true), onStagesDone: () => (doneA = true) },
    });

    orchA.start(); // sends stage-prepare into the void, then waits for stage-armed forever
    advance([bulkA], 20_000, 200);

    expect(doneA).toBe(false);
    expect(timeoutA).toBe(true);
    expect(orchA.getBank()).toHaveLength(0);
  });
});
