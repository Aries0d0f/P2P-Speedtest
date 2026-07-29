import { describe, expect, it } from "vitest";
import { computeResultHash } from "./result-hash";
import { validateData, validateEnvelope } from "./result-validate";

const ROOM = "4G7QZKX9M";
const PEER_A = "3f29a1c4-5e6b-5a2d-9f3e-1b7c8d4a2e10";
const PEER_B = "8a4d2b91-7c3e-5f1a-b6d8-2e9f4c7a1b35";

const edge = (from: string, to: string) => ({
  from,
  to,
  speed: 94500000,
  latency: 38.2,
  jitter: 2.1,
  loss: 0.0004,
});

function succeedData() {
  return {
    room: ROOM,
    status: "SUCCEED" as const,
    timestamp: "2026-07-29T14:32:07Z",
    peers: [
      { id: PEER_A, name: "Peer A" },
      { id: PEER_B, name: "Peer B" },
    ],
    bandwidth: {
      directional: [edge(PEER_A, PEER_B), edge(PEER_B, PEER_A)],
      duplex: [edge(PEER_A, PEER_B), edge(PEER_B, PEER_A)],
    },
    via: "DIRECT" as const,
  };
}

describe("validateData", () => {
  it("accepts a complete SUCCEED record", () => {
    expect(validateData(succeedData(), ROOM)).toEqual({ valid: true, errors: [] });
  });

  it("rejects a room mismatch", () => {
    const result = validateData(succeedData(), "OTHERROOM");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("data.room"))).toBe(true);
  });

  it("rejects an edge endpoint that isn't a known peer", () => {
    const data = succeedData();
    data.bandwidth.directional[0] = edge(PEER_A, "8a4d2b91-7c3e-5f1a-b6d8-2e9f4c7a1b99");
    const result = validateData(data, ROOM);
    expect(result.valid).toBe(false);
  });

  it("rejects from === to", () => {
    const data = succeedData();
    data.bandwidth.directional[0] = edge(PEER_A, PEER_A);
    data.bandwidth.directional[1] = edge(PEER_B, PEER_A);
    const result = validateData(data, ROOM);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("same peer"))).toBe(true);
  });

  it("rejects a two-edge group that is not a proper reverse pair (same direction twice)", () => {
    const data = succeedData();
    data.bandwidth.directional[1] = edge(PEER_A, PEER_B);
    const result = validateData(data, ROOM);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("reverse pair"))).toBe(true);
  });

  it("SUCCEED requires both groups full (schema conditional)", () => {
    const data = succeedData();
    data.bandwidth.duplex = [edge(PEER_A, PEER_B)];
    const result = validateData(data, ROOM);
    expect(result.valid).toBe(false);
  });

  it("SUCCEED requires via not UNKNOWN (schema conditional)", () => {
    const data: any = succeedData();
    data.via = "UNKNOWN";
    const result = validateData(data, ROOM);
    expect(result.valid).toBe(false);
  });

  it("accepts a FAILED record with a partial single-edge group and no duplex", () => {
    const data = {
      room: ROOM,
      status: "FAILED" as const,
      timestamp: "2026-07-29T14:32:07Z",
      peers: [
        { id: PEER_A, name: "Peer A" },
        { id: PEER_B, name: "Peer B" },
      ],
      bandwidth: { directional: [edge(PEER_A, PEER_B)] },
      via: "UNKNOWN" as const,
    };
    expect(validateData(data, ROOM)).toEqual({ valid: true, errors: [] });
  });

  it("accepts a CANCELED record with an empty bandwidth object", () => {
    const data = {
      room: ROOM,
      status: "CANCELED" as const,
      timestamp: "2026-07-29T14:32:07Z",
      peers: [
        { id: PEER_A, name: "Peer A" },
        { id: PEER_B, name: "Peer B" },
      ],
      bandwidth: {},
      via: "UNKNOWN" as const,
    };
    expect(validateData(data, ROOM)).toEqual({ valid: true, errors: [] });
  });

  it("rejects a violation of the ip format", () => {
    const data: any = succeedData();
    data.peers[0].ip = "not-an-ip";
    const result = validateData(data, ROOM);
    expect(result.valid).toBe(false);
  });

  it("rejects a violation of the uuid format for peer id", () => {
    const data: any = succeedData();
    data.peers[0].id = "not-a-uuid";
    const result = validateData(data, ROOM);
    expect(result.valid).toBe(false);
  });

  it("rejects a violation of the date-time format for timestamp", () => {
    const data: any = succeedData();
    data.timestamp = "not-a-timestamp";
    const result = validateData(data, ROOM);
    expect(result.valid).toBe(false);
  });
});

describe("validateEnvelope", () => {
  async function makeEnvelope() {
    const data = succeedData();
    const hash = await computeResultHash(data);
    return {
      apiVersion: "sws.aries0d0f.me/v1",
      kind: "P2PSpeedtestResult",
      metadata: { id: ROOM, "peer-id": PEER_A, hash },
      data,
    };
  }

  it("accepts a well-formed, correctly-hashed envelope", async () => {
    const entry = await makeEnvelope();
    expect(await validateEnvelope(entry)).toEqual({ valid: true, errors: [] });
  });

  it("rejects a checksum mismatch", async () => {
    const entry = await makeEnvelope();
    entry.metadata.hash = "0".repeat(64);
    const result = await validateEnvelope(entry);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("hash"))).toBe(true);
  });

  it("rejects metadata.id not matching data.room", async () => {
    const entry = await makeEnvelope();
    entry.metadata.id = "OTHERROOMX";
    const result = await validateEnvelope(entry);
    expect(result.valid).toBe(false);
  });

  it("rejects metadata.peer-id not present in data.peers", async () => {
    const entry = await makeEnvelope();
    entry.metadata["peer-id"] = "8a4d2b91-7c3e-5f1a-b6d8-2e9f4c7a1b99";
    const result = await validateEnvelope(entry);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("peer-id"))).toBe(true);
  });

  it("rejects a wrong apiVersion or kind", async () => {
    const entry = await makeEnvelope();
    (entry as any).apiVersion = "wrong/v1";
    expect((await validateEnvelope(entry)).valid).toBe(false);
  });
});
