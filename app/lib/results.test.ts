import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { computeResultHash } from "./result-hash";
import { buildMetadata, listResults, saveResult, type P2PSpeedtestResult } from "./results";

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

async function makeResult(peerId: string, room = ROOM): Promise<P2PSpeedtestResult> {
  const data = {
    room,
    status: "SUCCEED" as const,
    timestamp: "2026-07-29T14:32:07Z",
    peers: [
      { id: PEER_A, name: "Peer A" },
      { id: PEER_B, name: "Peer B" },
    ] as [any, any],
    bandwidth: {
      directional: [edge(PEER_A, PEER_B), edge(PEER_B, PEER_A)],
      duplex: [edge(PEER_A, PEER_B), edge(PEER_B, PEER_A)],
    },
    via: "DIRECT" as const,
  };
  const hash = await computeResultHash(data);
  return {
    apiVersion: "sws.aries0d0f.me/v1",
    kind: "P2PSpeedtestResult",
    metadata: buildMetadata(room, peerId, hash),
    data,
  };
}

// fake-indexeddb persists per-process; reset between tests by deleting the
// database so each test starts from an empty store.
beforeEach(async () => {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase("p2p-speedtest");
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
});

describe("saveResult / listResults", () => {
  it("saves a new result and lists it back", async () => {
    const result = await makeResult(PEER_A);
    expect(await saveResult(result)).toEqual({ status: "saved" });

    const listed = await listResults();
    expect(listed).toEqual({ status: "ok", results: [result], warnings: [] });
  });

  it("dedupes a second save for the same identity as first-write-wins", async () => {
    const first = await makeResult(PEER_A);
    const second = await makeResult(PEER_A); // same room+peerId, different object identity

    expect(await saveResult(first)).toEqual({ status: "saved" });
    expect(await saveResult(second)).toEqual({ status: "deduplicated" });

    const listed = await listResults();
    expect(listed.status).toBe("ok");
    if (listed.status === "ok") expect(listed.results).toHaveLength(1);
  });

  it("keeps both rows when two different peer identities save for the same room", async () => {
    const a = await makeResult(PEER_A);
    const b = await makeResult(PEER_B);

    expect(await saveResult(a)).toEqual({ status: "saved" });
    expect(await saveResult(b)).toEqual({ status: "saved" });

    const listed = await listResults();
    expect(listed.status).toBe("ok");
    if (listed.status === "ok") expect(listed.results).toHaveLength(2);
  });

  it("concurrent saves for the same identity commit exactly one row", async () => {
    const a = await makeResult(PEER_A);
    const b = await makeResult(PEER_A);

    const [r1, r2] = await Promise.all([saveResult(a), saveResult(b)]);
    const outcomes = [r1.status, r2.status].sort();
    expect(outcomes).toEqual(["deduplicated", "saved"]);

    const listed = await listResults();
    expect(listed.status).toBe("ok");
    if (listed.status === "ok") expect(listed.results).toHaveLength(1);
  });

  it("skips a malformed stored row with a warning rather than failing the whole read", async () => {
    const good = await makeResult(PEER_A);
    await saveResult(good);

    // Insert a malformed row directly, bypassing saveResult's validation.
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("p2p-speedtest", 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("results", "readwrite");
      tx.objectStore("results").add({ not: "a valid envelope" }, [ROOM, "bogus-peer-id"]);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });

    const listed = await listResults();
    expect(listed.status).toBe("ok");
    if (listed.status === "ok") {
      expect(listed.results).toEqual([good]);
      expect(listed.warnings).toHaveLength(1);
    }
  });
});
