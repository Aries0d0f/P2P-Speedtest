import { describe, expect, it } from "vitest";

import type { StageProgressSnapshot } from "~/lib/control-channel";
import { DOWNLOAD, DUPLEX, UPLOAD, edgeKey, type Slot, type StageId } from "~/lib/stage";
import {
  describePresentation,
  selectLiveTestPresentation,
  selectStoredResultPresentation,
  snapshotLoss,
  snapshotMbps,
  toVisualLocation,
  tokenForRole,
  type LiveTestRoomView,
} from "~/lib/test-visualization";

const RUN = "run-1";

function snapshot(
  stageId: StageId,
  receiverSlot: Slot,
  over: Partial<StageProgressSnapshot> = {},
): StageProgressSnapshot {
  return {
    stageId,
    receiverSlot,
    // 1.25 MB in 1000 ms == 10 Mbps, so every expectation below is a round
    // number rather than a floating-point near-miss.
    bytes: 1_250_000,
    elapsedMs: 1000,
    chunksSeen: 100,
    highestSeqPlusOne: 100,
    ...over,
  };
}

function view(over: Partial<LiveTestRoomView> = {}): LiveTestRoomView {
  return {
    runId: RUN,
    phase: "testing",
    stageId: null,
    progressRunId: RUN,
    progress: {},
    liveLatency: null,
    latencyBaseline: undefined,
    connectionType: "DIRECT",
    localProfile: { name: "Local", geo: { lat: 35.68, lon: 139.69 } },
    remoteProfile: { name: "Remote", geo: { lat: 52.52, lon: 13.4 } },
    ...over,
  };
}

function withStage(stageId: StageId, over: Partial<LiveTestRoomView> = {}): LiveTestRoomView {
  return view({ stageId, ...over });
}

describe("selectLiveTestPresentation — stage and local view mapping", () => {
  // The single most dangerous bug in this phase: a correct measurement
  // narrated as the wrong direction. Every one of the six cases is pinned.
  const cases: Array<{
    stage: StageId;
    localSlot: Slot;
    mode: string;
    // physical sender -> receiver, identical on both browsers
    edges: Array<{ sender: Slot; receiver: Slot; role: string; token: string }>;
  }> = [
    {
      stage: DOWNLOAD,
      localSlot: 0,
      mode: "send",
      edges: [{ sender: 0, receiver: 1, role: "send", token: "--transfer-send" }],
    },
    {
      stage: DOWNLOAD,
      localSlot: 1,
      mode: "receive",
      edges: [{ sender: 0, receiver: 1, role: "receive", token: "--transfer-receive" }],
    },
    {
      stage: UPLOAD,
      localSlot: 0,
      mode: "receive",
      edges: [{ sender: 1, receiver: 0, role: "receive", token: "--transfer-receive" }],
    },
    {
      stage: UPLOAD,
      localSlot: 1,
      mode: "send",
      edges: [{ sender: 1, receiver: 0, role: "send", token: "--transfer-send" }],
    },
    {
      stage: DUPLEX,
      localSlot: 0,
      mode: "duplex",
      edges: [
        { sender: 1, receiver: 0, role: "receive", token: "--transfer-duplex" },
        { sender: 0, receiver: 1, role: "send", token: "--transfer-duplex" },
      ],
    },
    {
      stage: DUPLEX,
      localSlot: 1,
      mode: "duplex",
      edges: [
        { sender: 0, receiver: 1, role: "receive", token: "--transfer-duplex" },
        { sender: 1, receiver: 0, role: "send", token: "--transfer-duplex" },
      ],
    },
  ];

  for (const c of cases) {
    it(`stage ${c.stage} as slot ${c.localSlot} is ${c.mode}`, () => {
      const p = selectLiveTestPresentation(withStage(c.stage), c.localSlot);
      expect(p.mode).toBe(c.mode);
      expect(p.channels).toHaveLength(c.edges.length);
      expect(
        p.channels.map((ch) => ({
          sender: ch.senderSlot,
          receiver: ch.receiverSlot,
          role: ch.role,
          token: ch.token,
        })),
      ).toEqual(c.edges);
    });
  }

  it("gives both slots the same physical direction for a directional stage", () => {
    const asSender = selectLiveTestPresentation(withStage(DOWNLOAD), 0).channels[0];
    const asReceiver = selectLiveTestPresentation(withStage(DOWNLOAD), 1).channels[0];
    expect(asSender.senderSlot).toBe(asReceiver.senderSlot);
    expect(asSender.receiverSlot).toBe(asReceiver.receiverSlot);
    // ...but opposite local colour, which is the whole point of the contract.
    expect(asSender.token).not.toBe(asReceiver.token);
  });

  it("labels channels so colour is never the only distinction", () => {
    const p = selectLiveTestPresentation(withStage(DUPLEX), 0);
    expect(p.channels.map((c) => c.label)).toEqual(["You receive", "You send"]);
  });
});

describe("selectLiveTestPresentation — receiver-observed speeds", () => {
  it("reads the receiver snapshot for the local receive edge", () => {
    const p = selectLiveTestPresentation(
      withStage(DOWNLOAD, { progress: { [edgeKey(DOWNLOAD, 1)]: snapshot(DOWNLOAD, 1) } }),
      1,
    );
    expect(p.channels[0].mbps).toBeCloseTo(10, 6);
  });

  it("shows the sender the same receiver-observed number, not its own bytes", () => {
    const progress = { [edgeKey(DOWNLOAD, 1)]: snapshot(DOWNLOAD, 1, { bytes: 500_000 }) };
    const sender = selectLiveTestPresentation(withStage(DOWNLOAD, { progress }), 0);
    const receiver = selectLiveTestPresentation(withStage(DOWNLOAD, { progress }), 1);
    expect(sender.channels[0].mbps).toBe(receiver.channels[0].mbps);
    expect(sender.channels[0].mbps).toBeCloseTo(4, 6);
  });

  it("keeps both duplex directions separate and never combines them", () => {
    const p = selectLiveTestPresentation(
      withStage(DUPLEX, {
        progress: {
          [edgeKey(DUPLEX, 0)]: snapshot(DUPLEX, 0, { bytes: 1_250_000 }),
          [edgeKey(DUPLEX, 1)]: snapshot(DUPLEX, 1, { bytes: 2_500_000 }),
        },
      }),
      0,
    );
    expect(p.channels.map((c) => c.mbps)).toEqual([10, 20]);
    // No aggregate field exists at all, so nothing downstream can render one.
    expect(p).not.toHaveProperty("totalMbps");
    expect(p).not.toHaveProperty("averageMbps");
  });

  it("emits null rather than 0 when no progress has arrived", () => {
    const p = selectLiveTestPresentation(withStage(UPLOAD), 0);
    expect(p.channels[0].mbps).toBeNull();
    expect(p.channels[0].loss).toBeNull();
  });

  it("keeps a genuine zero-byte reading distinguishable from no reading", () => {
    const p = selectLiveTestPresentation(
      withStage(UPLOAD, { progress: { [edgeKey(UPLOAD, 0)]: snapshot(UPLOAD, 0, { bytes: 0 }) } }),
      0,
    );
    expect(p.channels[0].mbps).toBe(0);
  });

  it("reports receiver-observed loss", () => {
    const p = selectLiveTestPresentation(
      withStage(DOWNLOAD, {
        progress: {
          [edgeKey(DOWNLOAD, 1)]: snapshot(DOWNLOAD, 1, { chunksSeen: 90, highestSeqPlusOne: 100 }),
        },
      }),
      1,
    );
    expect(p.channels[0].loss).toBeCloseTo(0.1, 6);
  });

  it("carries the final (highest-elapsed) update like any other sample", () => {
    const final = snapshot(DOWNLOAD, 1, { bytes: 12_500_000, elapsedMs: 10_000 });
    const p = selectLiveTestPresentation(
      withStage(DOWNLOAD, { progress: { [edgeKey(DOWNLOAD, 1)]: final } }),
      1,
    );
    expect(p.channels[0].mbps).toBeCloseTo(10, 6);
  });
});

describe("selectLiveTestPresentation — staleness", () => {
  it("drops a progress bank retained from an earlier run", () => {
    const p = selectLiveTestPresentation(
      withStage(DOWNLOAD, {
        progressRunId: "run-0",
        progress: { [edgeKey(DOWNLOAD, 1)]: snapshot(DOWNLOAD, 1) },
      }),
      1,
    );
    expect(p.channels[0].mbps).toBeNull();
  });

  it("ignores snapshots belonging to a stage that is not active", () => {
    const p = selectLiveTestPresentation(
      withStage(UPLOAD, {
        progress: {
          [edgeKey(DOWNLOAD, 1)]: snapshot(DOWNLOAD, 1),
          [edgeKey(DUPLEX, 0)]: snapshot(DUPLEX, 0),
        },
      }),
      0,
    );
    expect(p.channels).toHaveLength(1);
    expect(p.channels[0].stageId).toBe(UPLOAD);
    expect(p.channels[0].mbps).toBeNull();
  });

  it("resets to idle when the run has no id yet", () => {
    const p = selectLiveTestPresentation(
      withStage(DOWNLOAD, {
        runId: null,
        progressRunId: null,
        progress: { [edgeKey(DOWNLOAD, 1)]: snapshot(DOWNLOAD, 1) },
      }),
      1,
    );
    // A null runId cannot match, so nothing from the bank is trusted.
    expect(p.channels[0].mbps).toBeNull();
    expect(p.runId).toBeNull();
  });
});

describe("selectLiveTestPresentation — phases", () => {
  it("is idle and inactive before testing", () => {
    for (const phase of ["waiting", "pairing", "paired"] as const) {
      const p = selectLiveTestPresentation(withStage(DOWNLOAD, { phase }), 0);
      expect(p.active).toBe(false);
      expect(p.mode).toBe("idle");
      expect(p.channels).toEqual([]);
    }
  });

  it("is active with no channels during the latency warm-up", () => {
    const p = selectLiveTestPresentation(view({ stageId: null }), 0);
    expect(p.active).toBe(true);
    expect(p.mode).toBe("idle");
    expect(p.channels).toEqual([]);
  });

  it("holds the last reading while finalizing, but stops the flow", () => {
    const p = selectLiveTestPresentation(
      withStage(DUPLEX, {
        phase: "finalizing",
        progress: { [edgeKey(DUPLEX, 0)]: snapshot(DUPLEX, 0) },
      }),
      0,
    );
    expect(p.frozen).toBe(true);
    // Not active: particles stop and no new sample is treated as live.
    expect(p.active).toBe(false);
    // ...but the gauge still has something to freeze on.
    expect(p.mode).toBe("duplex");
    expect(p.channels).toHaveLength(2);
    expect(p.channels[0].mbps).toBe(10);
  });

  it("clears the stage once the run has produced its result", () => {
    const p = selectLiveTestPresentation(withStage(DUPLEX, { phase: "result" }), 0);
    expect(p.frozen).toBe(true);
    expect(p.active).toBe(false);
    expect(p.mode).toBe("idle");
    expect(p.channels).toEqual([]);
  });
});

describe("selectLiveTestPresentation — peers and locations", () => {
  it("uses shared coordinates for both markers", () => {
    const p = selectLiveTestPresentation(view(), 0);
    expect(p.localPeer.location).toEqual({ lat: 35.68, lon: 139.69 });
    expect(p.remotePeer.location).toEqual({ lat: 52.52, lon: 13.4 });
    expect(p.remotePeer.slot).toBe(1);
  });

  it("swaps local/remote by slot", () => {
    const p = selectLiveTestPresentation(view(), 1);
    expect(p.localPeer.slot).toBe(1);
    expect(p.localPeer.name).toBe("Local");
    expect(p.remotePeer.slot).toBe(0);
  });

  it("invents no coordinates for an Anonymous or missing profile", () => {
    const p = selectLiveTestPresentation(
      view({ remoteProfile: { name: "Anon" }, localProfile: null }),
      0,
    );
    expect(p.remotePeer.location).toBeNull();
    expect(p.remotePeer.profileKnown).toBe(true);
    expect(p.localPeer.location).toBeNull();
    expect(p.localPeer.profileKnown).toBe(false);
    expect(p.localPeer.name).toBe("Peer A");
  });

  it("treats out-of-range and non-finite coordinates as unavailable", () => {
    expect(toVisualLocation({ lat: 91, lon: 0 })).toBeNull();
    expect(toVisualLocation({ lat: 0, lon: 181 })).toBeNull();
    expect(toVisualLocation({ lat: Number.NaN, lon: 0 })).toBeNull();
    expect(toVisualLocation({ lat: 0, lon: Number.POSITIVE_INFINITY })).toBeNull();
    expect(toVisualLocation({ lat: 0 })).toBeNull();
    expect(toVisualLocation(undefined)).toBeNull();
    expect(toVisualLocation({ lat: -90, lon: 180 })).toEqual({ lat: -90, lon: 180 });
  });

  it("accepts a location that arrives after measurement started", () => {
    const before = selectLiveTestPresentation(
      withStage(DOWNLOAD, { remoteProfile: { name: "Remote" } }),
      0,
    );
    const after = selectLiveTestPresentation(
      withStage(DOWNLOAD, { remoteProfile: { name: "Remote", geo: { lat: 1, lon: 2 } } }),
      0,
    );
    expect(before.remotePeer.location).toBeNull();
    expect(after.remotePeer.location).toEqual({ lat: 1, lon: 2 });
    // Nothing about the measurement changed as a result.
    expect(after.stageId).toBe(before.stageId);
  });
});

describe("selectLiveTestPresentation — latency", () => {
  it("prefers the finalized baseline over the live reading", () => {
    const p = selectLiveTestPresentation(
      view({
        liveLatency: { rttMs: 99, jitterMs: 9, sampleCount: 5 },
        latencyBaseline: { rttMs: 42, jitterMs: 4, sampleCount: 20 } as never,
      }),
      0,
    );
    expect(p.latency).toEqual({ rttMs: 42, jitterMs: 4 });
  });

  it("reports no latency when the baseline finalized empty", () => {
    const p = selectLiveTestPresentation(
      view({ liveLatency: { rttMs: 99, jitterMs: 9, sampleCount: 2 }, latencyBaseline: null }),
      0,
    );
    expect(p.latency).toBeNull();
  });
});

describe("selectStoredResultPresentation", () => {
  const PEER_A = { id: "id-a", name: "Ada", geo: { lat: 35.68, lon: 139.69 } };
  const PEER_B = { id: "id-b", name: "Grace", geo: { lat: 52.52, lon: 13.4 } };

  it("puts the record's own peer on the local side, whichever slot it holds", () => {
    const asA = selectStoredResultPresentation({
      runId: "r",
      peers: [PEER_A, PEER_B],
      localPeerId: "id-a",
      connectionType: "DIRECT",
    });
    expect(asA.localPeer.name).toBe("Ada");
    expect(asA.localPeer.slot).toBe(0);
    expect(asA.remotePeer.name).toBe("Grace");

    const asB = selectStoredResultPresentation({
      runId: "r",
      peers: [PEER_A, PEER_B],
      localPeerId: "id-b",
      connectionType: "DIRECT",
    });
    expect(asB.localPeer.name).toBe("Grace");
    expect(asB.localPeer.slot).toBe(1);
    expect(asB.remotePeer.name).toBe("Ada");
  });

  it("carries both stored locations onto the globe", () => {
    const p = selectStoredResultPresentation({
      runId: "r",
      peers: [PEER_A, PEER_B],
      localPeerId: "id-a",
      connectionType: "RELAY",
    });
    expect(p.localPeer.location).toEqual({ lat: 35.68, lon: 139.69 });
    expect(p.remotePeer.location).toEqual({ lat: 52.52, lon: 13.4 });
    expect(p.connectionType).toBe("RELAY");
  });

  it("is a frozen, stage-less snapshot with no live channels", () => {
    const p = selectStoredResultPresentation({
      runId: "r",
      peers: [PEER_A, PEER_B],
      localPeerId: "id-a",
      connectionType: "DIRECT",
    });
    expect(p.frozen).toBe(true);
    expect(p.active).toBe(false);
    expect(p.mode).toBe("idle");
    expect(p.channels).toEqual([]);
    expect(p.latency).toBeNull();
  });

  it("says a peer withheld its location rather than inventing one", () => {
    const p = selectStoredResultPresentation({
      runId: "r",
      peers: [PEER_A, { id: "id-b", name: "Anon" }],
      localPeerId: "id-a",
      connectionType: "DIRECT",
    });
    expect(p.remotePeer.location).toBeNull();
    expect(p.remotePeer.profileKnown).toBe(true);
  });

  it("falls back to slot 0 when the record's peer id matches neither entry", () => {
    // A corrupt or hand-edited record must still render something coherent
    // rather than throwing on the results page.
    const p = selectStoredResultPresentation({
      runId: "r",
      peers: [PEER_A, PEER_B],
      localPeerId: "id-missing",
      connectionType: "UNKNOWN",
    });
    expect(p.localPeer.name).toBe("Ada");
    expect(p.remotePeer.name).toBe("Grace");
  });
});

describe("purity and input surface", () => {
  it("does not mutate its input", () => {
    const v = withStage(DUPLEX, {
      progress: { [edgeKey(DUPLEX, 0)]: snapshot(DUPLEX, 0) },
    });
    const before = JSON.stringify(v);
    selectLiveTestPresentation(v, 0);
    expect(JSON.stringify(v)).toBe(before);
  });

  it("returns the same output for the same input", () => {
    const v = withStage(UPLOAD, { progress: { [edgeKey(UPLOAD, 0)]: snapshot(UPLOAD, 0) } });
    expect(selectLiveTestPresentation(v, 0)).toEqual(selectLiveTestPresentation(v, 0));
  });

  it("accepts no transport, channel, or sender-byte input", () => {
    // A structural guard rather than a type-level one: if someone widens
    // `LiveTestRoomView` with a channel handle or a sender-side counter, this
    // list has to be updated deliberately.
    expect(Object.keys(view()).sort()).toEqual(
      [
        "connectionType",
        "latencyBaseline",
        "liveLatency",
        "localProfile",
        "phase",
        "progress",
        "progressRunId",
        "remoteProfile",
        "runId",
        "stageId",
      ].sort(),
    );
  });

  it("reads only receiver-observed fields from a snapshot", () => {
    // Anything the selector touches must be present on this object; a
    // sender-buffered counter is deliberately not one of the fields.
    const keys = Object.keys(snapshot(DOWNLOAD, 1));
    expect(keys.sort()).toEqual(
      ["bytes", "chunksSeen", "elapsedMs", "highestSeqPlusOne", "receiverSlot", "stageId"].sort(),
    );
  });
});

describe("derived helpers", () => {
  it("maps roles to tokens", () => {
    expect(tokenForRole("receive", "receive")).toBe("--transfer-receive");
    expect(tokenForRole("send", "send")).toBe("--transfer-send");
    expect(tokenForRole("duplex", "receive")).toBe("--transfer-duplex");
    expect(tokenForRole("duplex", "send")).toBe("--transfer-duplex");
    expect(tokenForRole("idle", "receive")).toBe("--transfer-idle");
  });

  it("computes Mbps and loss defensively", () => {
    expect(snapshotMbps(snapshot(DOWNLOAD, 1, { elapsedMs: 0 }))).toBeNull();
    expect(snapshotMbps(snapshot(DOWNLOAD, 1, { elapsedMs: -1 }))).toBeNull();
    expect(snapshotLoss(snapshot(DOWNLOAD, 1, { highestSeqPlusOne: 0 }))).toBeNull();
    expect(snapshotLoss(snapshot(DOWNLOAD, 1, { chunksSeen: 120, highestSeqPlusOne: 100 }))).toBe(0);
  });
});

describe("describePresentation", () => {
  it("states both peers, the direction, and the live number", () => {
    const text = describePresentation(
      selectLiveTestPresentation(
        withStage(DOWNLOAD, { progress: { [edgeKey(DOWNLOAD, 1)]: snapshot(DOWNLOAD, 1) } }),
        1,
      ),
    );
    expect(text).toContain("Local (you)");
    expect(text).toContain("Stage: download");
    expect(text).toContain("Remote to Local: 10.0 Mbps");
  });

  it("says which peer's location is missing", () => {
    const text = describePresentation(
      selectLiveTestPresentation(view({ remoteProfile: { name: "Anon" } }), 0),
    );
    expect(text).toContain("Anon — location not shared");
  });

  it("says no reading yet rather than 0 Mbps", () => {
    const text = describePresentation(selectLiveTestPresentation(withStage(UPLOAD), 0));
    expect(text).toContain("no reading yet");
    expect(text).not.toContain("0.0 Mbps");
  });
});
