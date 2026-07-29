import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BULK_FRAME_HEADER_BYTES,
  BulkReceiver,
  BulkSender,
  encodeBulkFrame,
  HARD_DEADLINE_MARGIN_MS,
  parseBulkFrame,
  PROGRESS_INTERVAL_MS,
  QUIET_PERIOD_MS,
  RAMP_UP_MS,
  type BulkChannel,
  type BulkFrame,
} from "./throughput";
import { uuidToBytes } from "./uuid-bytes";

const RUN_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_RUN_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("encodeBulkFrame / parseBulkFrame", () => {
  it("round-trips a ramp-up frame", () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const encoded = encodeBulkFrame({ runId: RUN_ID, stageId: 0, seq: 0, kind: "ramp-up", data });
    expect(parseBulkFrame(encoded)).toEqual({ runId: RUN_ID, stageId: 0, seq: 0, kind: "ramp-up", data });
  });

  it("round-trips a measured frame with a large seq", () => {
    const data = new Uint8Array(16);
    data.fill(9);
    const encoded = encodeBulkFrame({ runId: RUN_ID, stageId: 1, seq: 123456, kind: "measured", data });
    const parsed = parseBulkFrame(encoded);
    expect(parsed?.seq).toBe(123456);
    expect(parsed?.stageId).toBe(1);
    expect(parsed?.kind).toBe("measured");
    expect(parsed?.data).toEqual(data);
  });

  it("round-trips a header-only end marker", () => {
    const encoded = encodeBulkFrame({ runId: RUN_ID, stageId: 2, seq: 42, kind: "end" });
    expect(parseBulkFrame(encoded)).toEqual({
      runId: RUN_ID,
      stageId: 2,
      seq: 42,
      kind: "end",
      data: new Uint8Array(0),
    });
  });

  it("rejects a truncated header", () => {
    expect(parseBulkFrame(new ArrayBuffer(21))).toBeNull();
    expect(parseBulkFrame(new ArrayBuffer(0))).toBeNull();
  });

  it("rejects an unknown kind byte", () => {
    const encoded = encodeBulkFrame({ runId: RUN_ID, stageId: 0, seq: 0, kind: "measured", data: new Uint8Array([1]) });
    new Uint8Array(encoded)[21] = 99;
    expect(parseBulkFrame(encoded)).toBeNull();
  });

  it("rejects an unknown stageId byte", () => {
    const encoded = encodeBulkFrame({ runId: RUN_ID, stageId: 0, seq: 0, kind: "measured", data: new Uint8Array([1]) });
    new Uint8Array(encoded)[16] = 5;
    expect(parseBulkFrame(encoded)).toBeNull();
  });

  it("rejects an end marker carrying a payload", () => {
    expect(() =>
      encodeBulkFrame({ runId: RUN_ID, stageId: 0, seq: 0, kind: "end", data: new Uint8Array([1]) }),
    ).toThrow();

    // Also reject at parse time for a frame built by hand (not through the encoder).
    const buffer = new ArrayBuffer(23);
    const bytes = new Uint8Array(buffer);
    bytes.set(uuidToBytes(RUN_ID), 0);
    bytes[16] = 0;
    bytes[21] = 2; // end
    bytes[22] = 7; // stray payload byte
    expect(parseBulkFrame(buffer)).toBeNull();
  });

  it("rejects an empty-data ramp-up or measured frame", () => {
    expect(() =>
      encodeBulkFrame({ runId: RUN_ID, stageId: 0, seq: 0, kind: "ramp-up", data: new Uint8Array(0) }),
    ).toThrow();
    expect(() =>
      encodeBulkFrame({ runId: RUN_ID, stageId: 0, seq: 0, kind: "measured", data: new Uint8Array(0) }),
    ).toThrow();
  });
});

// A fake RTCDataChannel that models bufferedAmount synchronously: send()
// adds to it, drain() simulates the network catching up and fires
// bufferedamountlow when the level drops at/below threshold — mirroring
// the real browser contract the send loop is written against.
class FakeChannel implements BulkChannel {
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  sent: ArrayBuffer[] = [];
  private listeners: Array<() => void> = [];

  send(data: ArrayBuffer): void {
    // Real `RTCDataChannel.send(ArrayBuffer)` copies the bytes before
    // returning (structured-clone semantics) — BulkSender relies on that
    // to safely reuse one buffer across calls, so the fake must copy too,
    // or every recorded frame would alias the same mutated buffer.
    this.sent.push(data.slice(0));
    this.bufferedAmount += data.byteLength;
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

describe("BulkSender", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("sends ramp-up frames that don't consume the measured sequence space, then measured frames, then one end marker", () => {
    vi.setSystemTime(0);
    const channel = new FakeChannel();
    let completedWith: number | undefined;
    const sender = new BulkSender({
      channel,
      runId: RUN_ID,
      stageId: 0,
      chunkBytes: 100,
      maxDurationMs: 1000,
      maxBytes: 1_000_000,
      // Pinned explicitly rather than relying on the module's RAMP_UP_MS:
      // the backpressure threshold is now generous enough (16 MiB floor)
      // that a real ramp-up window would fully drain-and-refill many times
      // over on this fake channel's instant `drain()` before real time
      // elapses, generating and retaining a huge number of frames for no
      // reason. A short, test-scoped ramp-up keeps that burst bounded.
      rampUpMs: 20,
      onComplete: (n) => (completedWith = n),
    });

    sender.start();
    // With a buffer this large relative to this test's small transfer, the
    // whole thing can complete within a couple of drain cycles rather than
    // one distinct burst per phase — check the shape of the *whole*
    // recorded sequence instead of snapshotting between phases.
    for (let i = 0; i < 10 && completedWith === undefined; i++) {
      vi.setSystemTime(20 + i * 1000);
      channel.drain();
    }
    expect(completedWith).toBeGreaterThan(0);

    const frames = channel.sent.map((b) => parseBulkFrame(b)!);
    const rampUp = frames.filter((f) => f.kind === "ramp-up");
    const measured = frames.filter((f) => f.kind === "measured");
    const end = frames.filter((f) => f.kind === "end");

    expect(rampUp.length).toBeGreaterThan(0);
    expect(rampUp.every((f) => f.seq === 0)).toBe(true);
    expect(measured.length).toBeGreaterThan(0);
    expect(measured.map((f) => f.seq)).toEqual(measured.map((_, i) => i));
    expect(end).toHaveLength(1);
    expect(end[0].seq).toBe(sender.sentMeasuredChunks);
    expect(completedWith).toBe(sender.sentMeasuredChunks);

    // Every ramp-up frame precedes every measured frame, which precedes
    // the single end frame — no interleaving or reordering.
    const kinds = frames.map((f) => f.kind);
    const lastRampUp = kinds.lastIndexOf("ramp-up");
    const firstMeasured = kinds.indexOf("measured");
    expect(lastRampUp).toBeLessThan(firstMeasured);
    expect(kinds[kinds.length - 1]).toBe("end");
  });

  it("stops sending mid-buffer without ever exceeding the low-water threshold at rest", () => {
    vi.setSystemTime(RAMP_UP_MS); // skip ramp-up for this test
    const channel = new FakeChannel();
    const sender = new BulkSender({
      channel,
      runId: RUN_ID,
      stageId: 0,
      chunkBytes: 1000,
      maxDurationMs: 60_000,
      maxBytes: 1_000_000_000,
      rampUpMs: 0,
    });
    sender.start();
    // The loop checks bufferedAmount *before* each send, so the very last
    // send that crosses the threshold is still allowed through — bounded
    // overshoot of at most one frame (payload + the 22-byte header), never
    // unbounded queuing.
    const frameBytes = 1000 + BULK_FRAME_HEADER_BYTES;
    expect(channel.bufferedAmount).toBeLessThanOrEqual(
      channel.bufferedAmountLowThreshold + frameBytes,
    );
    expect(channel.bufferedAmount).toBeGreaterThan(channel.bufferedAmountLowThreshold - frameBytes);
  });

  it("stop() prevents any further sends, including the end marker", () => {
    vi.setSystemTime(0);
    const channel = new FakeChannel();
    const sender = new BulkSender({
      channel,
      runId: RUN_ID,
      stageId: 0,
      chunkBytes: 100,
      maxDurationMs: 1000,
      maxBytes: 1_000_000,
    });
    sender.start();
    sender.stop();
    channel.sent = [];
    vi.setSystemTime(10_000);
    channel.drain();
    expect(channel.sent).toEqual([]);
  });
});

describe("BulkReceiver", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function frame(seq: number, kind: BulkFrame["kind"] = "measured", overrides: Partial<BulkFrame> = {}): BulkFrame {
    return { runId: RUN_ID, stageId: 0, seq, kind, data: kind === "end" ? new Uint8Array(0) : new Uint8Array(10), ...overrides };
  }

  it("counts distinct measured chunks matching runId/stageId and ignores stragglers", () => {
    vi.setSystemTime(0);
    const receiver = new BulkReceiver({ runId: RUN_ID, stageId: 0, maxDurationMs: 5000 });
    receiver.arm();

    receiver.handleFrame(frame(0));
    receiver.handleFrame(frame(1));
    receiver.handleFrame(frame(1)); // duplicate
    receiver.handleFrame({ ...frame(2), stageId: 1 }); // wrong stage
    receiver.handleFrame({ ...frame(3), runId: OTHER_RUN_ID }); // wrong run
    receiver.handleFrame(frame(4, "ramp-up")); // never counted

    expect(receiver.snapshot().chunksSeen).toBe(2);
    expect(receiver.snapshot().bytes).toBe(20);
  });

  it("closes the window on the end marker and measures duration to the last counted chunk, not the marker", () => {
    vi.setSystemTime(1000);
    const closes: string[] = [];
    const receiver = new BulkReceiver({
      runId: RUN_ID,
      stageId: 0,
      maxDurationMs: 5000,
      onWindowClosed: (r) => closes.push(r),
    });
    receiver.arm();

    receiver.handleFrame(frame(0));
    vi.setSystemTime(1050);
    receiver.handleFrame(frame(1)); // last counted chunk at t=1050

    vi.setSystemTime(2000); // marker arrives late
    receiver.handleFrame(frame(2, "end"));

    expect(closes).toEqual(["end-marker"]);
    const sealed = receiver.finalize(2);
    expect(sealed).toEqual({ bytes: 20, durationMs: 50, chunksSeen: 2, chunksExpected: 2 });
  });

  it("closes on a quiet period when no end marker ever arrives", () => {
    vi.setSystemTime(0);
    const closes: string[] = [];
    const receiver = new BulkReceiver({
      runId: RUN_ID,
      stageId: 0,
      maxDurationMs: 5000,
      onWindowClosed: (r) => closes.push(r),
    });
    receiver.arm();
    receiver.handleFrame(frame(0));
    vi.advanceTimersByTime(QUIET_PERIOD_MS - 1);
    expect(closes).toEqual([]);
    vi.advanceTimersByTime(2);
    expect(closes).toEqual(["quiet-period"]);
  });

  it("closes on its own hard deadline if nothing else ever arrives", () => {
    vi.setSystemTime(0);
    const closes: string[] = [];
    const receiver = new BulkReceiver({
      runId: RUN_ID,
      stageId: 0,
      maxDurationMs: 1000,
      onWindowClosed: (r) => closes.push(r),
    });
    receiver.arm();
    vi.advanceTimersByTime(RAMP_UP_MS + 1000 + HARD_DEADLINE_MARGIN_MS - 1);
    expect(closes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(closes).toEqual(["hard-deadline"]);
  });

  it("finalize discards out-of-range sequence numbers using the sender's authoritative total", () => {
    vi.setSystemTime(0);
    const receiver = new BulkReceiver({ runId: RUN_ID, stageId: 0, maxDurationMs: 5000 });
    receiver.arm();
    receiver.handleFrame(frame(0));
    receiver.handleFrame(frame(1));
    receiver.handleFrame(frame(2)); // arrives, but sender only reports 2 sent
    receiver.handleFrame(frame(2, "end"));

    const sealed = receiver.finalize(2); // sender's sentMeasuredChunks
    expect(sealed?.chunksSeen).toBe(2);
    expect(sealed?.chunksExpected).toBe(2);
    expect(sealed?.bytes).toBe(20);
  });

  it("a dropped tail chunk raises loss without going negative", () => {
    vi.setSystemTime(0);
    const receiver = new BulkReceiver({ runId: RUN_ID, stageId: 0, maxDurationMs: 5000 });
    receiver.arm();
    receiver.handleFrame(frame(0));
    receiver.handleFrame(frame(1));
    // seq 2 (of 3 sent) never arrives
    receiver.handleFrame(frame(3, "end"));

    const sealed = receiver.finalize(3);
    expect(sealed).toEqual({ bytes: 20, durationMs: expect.any(Number), chunksSeen: 2, chunksExpected: 3 });
    const loss = 1 - sealed!.chunksSeen / sealed!.chunksExpected;
    expect(loss).toBeCloseTo(1 / 3);
    expect(loss).toBeGreaterThanOrEqual(0);
  });

  it("finalize returns null when the sender's total is missing or non-positive", () => {
    vi.setSystemTime(0);
    const receiver = new BulkReceiver({ runId: RUN_ID, stageId: 0, maxDurationMs: 5000 });
    receiver.arm();
    receiver.handleFrame(frame(0));
    expect(receiver.finalize(0)).toBeNull();

    const receiver2 = new BulkReceiver({ runId: RUN_ID, stageId: 0, maxDurationMs: 5000 });
    receiver2.arm();
    expect(receiver2.finalize(-1)).toBeNull();
  });

  it(`emits progress at most once per ${PROGRESS_INTERVAL_MS}ms plus one final update on close`, () => {
    vi.setSystemTime(0);
    const updates: number[] = [];
    const receiver = new BulkReceiver({
      runId: RUN_ID,
      stageId: 0,
      maxDurationMs: 5000,
      onProgress: (s) => updates.push(s.chunksSeen),
    });
    receiver.arm();

    receiver.handleFrame(frame(0)); // t=0 -> emits (first ever)
    receiver.handleFrame(frame(1)); // t=0 -> throttled
    vi.setSystemTime(Math.floor(PROGRESS_INTERVAL_MS / 3));
    receiver.handleFrame(frame(2)); // still within the interval -> throttled
    vi.setSystemTime(PROGRESS_INTERVAL_MS + 1);
    receiver.handleFrame(frame(3)); // interval elapsed -> emits
    expect(updates).toEqual([1, 4]);

    receiver.handleFrame(frame(4, "end")); // final update, unconditional
    expect(updates).toEqual([1, 4, 4]);
  });
});
