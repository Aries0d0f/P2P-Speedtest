import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BulkChannel } from "~/model/bulk-frame.model";
import type { StageMessage } from "~/model/control-message.model";
import { decodeControlMessage } from "./control-message";
import { parseBulkFrame } from "./throughput";

const RUN_ID = "11111111-2222-4333-8444-555555555555";

import type { StageBankEntry } from "~/model/measurement.model";
import type { ResultShare } from "~/model/result.model";
import type { PeerWithProfile } from "~/model/peer.model";
import { StageOrchestrator } from "./stage-orchestrator";
import { TerminalController } from "./terminal-controller";

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

  function peers(): [PeerWithProfile, PeerWithProfile] {
    return [
      { slot: 0, id: PEER_A_ID, profile: { name: "Peer A" } },
      { slot: 1, id: PEER_B_ID, profile: { name: "Peer B" } },
    ];
  }

  function link(
    a: TerminalController,
    b: TerminalController,
  ): { sendA: (raw: string) => void; sendB: (raw: string) => void } {
    const route = (target: TerminalController) => (raw: string) => {
      const msg = decodeControlMessage(raw, RUN_ID);
      if (!msg) return;
      if (msg.type === "result-share") target.handleResultShare(msg.payload as ResultShare);
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

  // 5.6 robustness matrix row: "Duplicate result-share | ignored | one entry only".
  it("a duplicate result-share is ignored — only the first is kept", async () => {
    // Deliberately missing this peer's view of the other slot's edges, so
    // the merge in `run()` has to pull them from the share rather than an
    // already-banked, already-acknowledged entry.
    const partialBank = (): StageBankEntry[] => [
      { stageId: 1, receiverSlot: 0, measurement: measurement(2) },
      { stageId: 2, receiverSlot: 0, measurement: measurement(3) },
    ];
    const a = new TerminalController({
      runId: RUN_ID,
      room: ROOM,
      timestamp: TIMESTAMP,
      selfSlot: 0,
      selfPeerId: PEER_A_ID,
      send: () => {},
      freezeStages: partialBank,
      getConnectionType: () => "DIRECT",
      getPeers: peers,
    });

    const first: ResultShare = {
      status: "SUCCEED",
      directional: measurement(100),
      duplex: measurement(101),
      via: "DIRECT",
    };
    const second: ResultShare = {
      status: "SUCCEED",
      directional: measurement(200),
      duplex: measurement(201),
      via: "DIRECT",
    };
    a.handleResultShare(first);
    a.handleResultShare(second);

    const outcome = await a.trigger({ kind: "clean" });
    expect(outcome.status).toBe("SUCCEED");
    const download = outcome.record?.data.bandwidth.directional?.find((e) => e.to === PEER_B_ID);
    const duplexFromB = outcome.record?.data.bandwidth.duplex?.find((e) => e.to === PEER_B_ID);
    // bytes = 1_000_000 + n, durationMs = 1000 -> speed = bytes * 8.
    expect(download?.speed).toBe((1_000_000 + 100) * 8);
    expect(duplexFromB?.speed).toBe((1_000_000 + 101) * 8);
  });

  // 5.6 robustness matrix row: "Share lost in one direction only | both
  // assemble | yes, both — checksums differ".
  it("a result-share lost in one direction still lets both sides assemble, with differing checksums", async () => {
    let a!: TerminalController;
    const b = new TerminalController({
      runId: RUN_ID,
      room: ROOM,
      timestamp: TIMESTAMP,
      selfSlot: 1,
      selfPeerId: PEER_B_ID,
      send: () => {}, // B's own share never reaches A — the one-direction loss
      freezeStages: fullBank,
      getConnectionType: () => "DIRECT",
      getPeers: peers,
    });
    a = new TerminalController({
      runId: RUN_ID,
      room: ROOM,
      timestamp: TIMESTAMP,
      selfSlot: 0,
      selfPeerId: PEER_A_ID,
      send: (raw) => {
        const msg = decodeControlMessage(raw, RUN_ID);
        if (msg?.type === "result-share") b.handleResultShare(msg.payload as ResultShare);
      },
      freezeStages: fullBank,
      getConnectionType: () => "DIRECT",
      getPeers: peers,
    });

    const p1 = a.trigger({ kind: "clean" });
    const p2 = b.trigger({ kind: "clean" });
    await vi.advanceTimersByTimeAsync(5_000); // a waits the full deadline for b's share, which never arrives
    const [outcomeA, outcomeB] = await Promise.all([p1, p2]);

    // A never received B's share, so its own record is honestly forced to
    // FAILED (S6) even though its own measurements all succeeded; B did
    // receive A's share, so B's own SUCCEED stands. Both still assemble and
    // (would) save a record — an honest disagreement, not corruption.
    expect(outcomeA.status).toBe("FAILED");
    expect(outcomeB.status).toBe("SUCCEED");
    expect(outcomeA.record).not.toBeNull();
    expect(outcomeB.record).not.toBeNull();
    expect(outcomeA.record?.metadata.hash).not.toBe(outcomeB.record?.metadata.hash);
  });
});
