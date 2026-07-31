import { describe, expect, it } from "vitest";
import type { LatencyAggregate } from "~/model/measurement.model";
import { decodeControlMessage, encodeControlMessage } from "./control-message";

const RUN_ID = "11111111-2222-4333-8444-555555555555";

describe("decodeControlMessage — latency vocabulary", () => {
  it("round-trips channel-ready, ping, and pong", () => {
    expect(
      decodeControlMessage(
        JSON.stringify({ runId: RUN_ID, type: "channel-ready", payload: {} }),
        RUN_ID,
      ),
    ).toEqual({ runId: RUN_ID, type: "channel-ready", payload: {} });

    expect(
      decodeControlMessage(
        JSON.stringify({ runId: RUN_ID, type: "ping", seq: 3, payload: {} }),
        RUN_ID,
      ),
    ).toEqual({ runId: RUN_ID, type: "ping", seq: 3, payload: {} });

    expect(
      decodeControlMessage(
        JSON.stringify({ runId: RUN_ID, type: "pong", seq: 3, payload: {} }),
        RUN_ID,
      ),
    ).toEqual({ runId: RUN_ID, type: "pong", seq: 3, payload: {} });
  });

  it("round-trips latency-ready carrying a real aggregate or an honest null", () => {
    const agg: LatencyAggregate = { rttMs: 42, jitterMs: 3 };
    expect(
      decodeControlMessage(
        JSON.stringify({ runId: RUN_ID, type: "latency-ready", payload: { aggregate: agg } }),
        RUN_ID,
      ),
    ).toEqual({ runId: RUN_ID, type: "latency-ready", payload: { aggregate: agg } });

    expect(
      decodeControlMessage(
        JSON.stringify({ runId: RUN_ID, type: "latency-ready", payload: { aggregate: null } }),
        RUN_ID,
      ),
    ).toEqual({ runId: RUN_ID, type: "latency-ready", payload: { aggregate: null } });
  });

  it("rejects a stale or foreign runId", () => {
    expect(
      decodeControlMessage(
        JSON.stringify({ runId: "other-run", type: "ping", seq: 0, payload: {} }),
        RUN_ID,
      ),
    ).toBeNull();
  });

  it("rejects malformed JSON and non-object payloads", () => {
    expect(decodeControlMessage("not json", RUN_ID)).toBeNull();
    expect(decodeControlMessage(JSON.stringify("a string"), RUN_ID)).toBeNull();
    expect(decodeControlMessage(42, RUN_ID)).toBeNull();
  });

  it("rejects a type outside the whole control vocabulary", () => {
    expect(
      decodeControlMessage(JSON.stringify({ runId: RUN_ID, type: "banana", payload: {} }), RUN_ID),
    ).toBeNull();
  });

  it("rejects ping/pong with a missing, non-integer, or negative seq", () => {
    expect(
      decodeControlMessage(JSON.stringify({ runId: RUN_ID, type: "ping", payload: {} }), RUN_ID),
    ).toBeNull();
    expect(
      decodeControlMessage(
        JSON.stringify({ runId: RUN_ID, type: "ping", seq: 1.5, payload: {} }),
        RUN_ID,
      ),
    ).toBeNull();
    expect(
      decodeControlMessage(
        JSON.stringify({ runId: RUN_ID, type: "ping", seq: -1, payload: {} }),
        RUN_ID,
      ),
    ).toBeNull();
  });

  it("rejects a latency-ready with a malformed or missing aggregate", () => {
    expect(
      decodeControlMessage(
        JSON.stringify({
          runId: RUN_ID,
          type: "latency-ready",
          payload: { aggregate: { rttMs: "x", jitterMs: 1 } },
        }),
        RUN_ID,
      ),
    ).toBeNull();
    expect(
      decodeControlMessage(
        JSON.stringify({ runId: RUN_ID, type: "latency-ready", payload: {} }),
        RUN_ID,
      ),
    ).toBeNull();
  });
});

describe("decodeControlMessage — stage vocabulary", () => {
  it("round-trips stage-prepare/armed/start", () => {
    for (const type of ["stage-prepare", "stage-armed", "stage-start"] as const) {
      expect(
        decodeControlMessage(JSON.stringify({ runId: RUN_ID, type, stageId: 1, payload: {} }), RUN_ID),
      ).toEqual({ runId: RUN_ID, type, stageId: 1, payload: {} });
    }
  });

  it("round-trips stage-complete with and without sentMeasuredChunks", () => {
    expect(
      decodeControlMessage(
        JSON.stringify({ runId: RUN_ID, type: "stage-complete", stageId: 0, payload: { sentMeasuredChunks: 42 } }),
        RUN_ID,
      ),
    ).toEqual({ runId: RUN_ID, type: "stage-complete", stageId: 0, payload: { sentMeasuredChunks: 42 } });

    expect(
      decodeControlMessage(
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
    expect(decodeControlMessage(JSON.stringify(msg), RUN_ID)).toEqual(msg);
  });

  it("round-trips stage-result and stage-result-ack", () => {
    const measurement = { bytes: 1000, durationMs: 100, latency: 10, jitter: 1, chunksSeen: 5, chunksExpected: 5 };
    expect(
      decodeControlMessage(
        JSON.stringify({ runId: RUN_ID, type: "stage-result", stageId: 0, receiverSlot: 1, payload: { measurement } }),
        RUN_ID,
      ),
    ).toEqual({ runId: RUN_ID, type: "stage-result", stageId: 0, receiverSlot: 1, payload: { measurement } });

    expect(
      decodeControlMessage(
        JSON.stringify({ runId: RUN_ID, type: "stage-result-ack", stageId: 0, receiverSlot: 1, payload: {} }),
        RUN_ID,
      ),
    ).toEqual({ runId: RUN_ID, type: "stage-result-ack", stageId: 0, receiverSlot: 1, payload: {} });
  });

  it("rejects a stage-result with an invalid measurement (chunksSeen > chunksExpected)", () => {
    const measurement = { bytes: 1000, durationMs: 100, latency: 10, jitter: 1, chunksSeen: 6, chunksExpected: 5 };
    expect(
      decodeControlMessage(
        JSON.stringify({ runId: RUN_ID, type: "stage-result", stageId: 0, receiverSlot: 1, payload: { measurement } }),
        RUN_ID,
      ),
    ).toBeNull();
  });

  it("rejects an unknown stageId or receiverSlot", () => {
    expect(
      decodeControlMessage(JSON.stringify({ runId: RUN_ID, type: "stage-prepare", stageId: 5, payload: {} }), RUN_ID),
    ).toBeNull();
    expect(
      decodeControlMessage(
        JSON.stringify({ runId: RUN_ID, type: "stage-result-ack", stageId: 0, receiverSlot: 2, payload: {} }),
        RUN_ID,
      ),
    ).toBeNull();
  });

  it("round-trips test-abort", () => {
    expect(
      decodeControlMessage(
        JSON.stringify({ runId: RUN_ID, type: "test-abort", payload: { status: "CANCELED", reason: "user-canceled" } }),
        RUN_ID,
      ),
    ).toEqual({ runId: RUN_ID, type: "test-abort", payload: { status: "CANCELED", reason: "user-canceled" } });
  });

  it("rejects test-abort with an empty reason or bad status", () => {
    expect(
      decodeControlMessage(
        JSON.stringify({ runId: RUN_ID, type: "test-abort", payload: { status: "CANCELED", reason: "" } }),
        RUN_ID,
      ),
    ).toBeNull();
    expect(
      decodeControlMessage(
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
    expect(decodeControlMessage(JSON.stringify(msg), RUN_ID)).toEqual(msg);
  });

  it("round-trips a FAILED result-share with partial measurements", () => {
    const measurement = { bytes: 1, durationMs: 1, latency: 1, jitter: 1, chunksSeen: 1, chunksExpected: 1 };
    const msg = {
      runId: RUN_ID,
      type: "result-share",
      payload: { status: "FAILED", reason: "peer-left", directional: measurement },
    };
    expect(decodeControlMessage(JSON.stringify(msg), RUN_ID)).toEqual(msg);
  });

  it("rejects a SUCCEED result-share missing directional/duplex/via", () => {
    expect(
      decodeControlMessage(
        JSON.stringify({ runId: RUN_ID, type: "result-share", payload: { status: "SUCCEED" } }),
        RUN_ID,
      ),
    ).toBeNull();
  });

  it("rejects a stale or foreign runId", () => {
    expect(
      decodeControlMessage(
        JSON.stringify({ runId: "other-run", type: "stage-prepare", stageId: 0, payload: {} }),
        RUN_ID,
      ),
    ).toBeNull();
  });

  it("rejects a type outside the whole control vocabulary", () => {
    expect(decodeControlMessage(JSON.stringify({ runId: RUN_ID, type: "banana", payload: {} }), RUN_ID)).toBeNull();
  });
});

describe("decodeControlMessage — peer-profile", () => {
  it("run-scopes the envelope and hands the payload through unsanitized", () => {
    const payload = { name: "Peer A", evil: "<script>" };
    expect(
      decodeControlMessage(
        JSON.stringify({ runId: RUN_ID, type: "peer-profile", payload }),
        RUN_ID,
      ),
    ).toEqual({ runId: RUN_ID, type: "peer-profile", payload });
  });

  it("rejects a stale or foreign runId", () => {
    expect(
      decodeControlMessage(
        JSON.stringify({ runId: "other-run", type: "peer-profile", payload: { name: "x" } }),
        RUN_ID,
      ),
    ).toBeNull();
  });
});

describe("encodeControlMessage", () => {
  it("round-trips through the decoder", () => {
    const msg = { runId: RUN_ID, type: "ping", seq: 4, payload: {} } as const;
    expect(decodeControlMessage(encodeControlMessage(msg), RUN_ID)).toEqual(msg);
  });
});
