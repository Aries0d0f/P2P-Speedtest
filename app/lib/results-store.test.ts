import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { computeResultHash } from "./result-hash";
import { buildMetadata, type P2PSpeedtestResult } from "~/model/result.model";
import {
  buildExportBundle,
  buildResultCopyText,
  getResult,
  importResults,
  listResults,
  saveResult,
} from "./results-store";

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

describe("getResult", () => {
  it("returns the record for a saved identity", async () => {
    const result = await makeResult(PEER_A);
    await saveResult(result);

    const outcome = await getResult(ROOM, PEER_A);
    expect(outcome).toEqual({ status: "ok", result });
  });

  it("returns not-found for an identity never saved", async () => {
    await makeResult(PEER_A).then(saveResult);
    expect(await getResult(ROOM, PEER_B)).toEqual({ status: "not-found" });
  });

  it("returns invalid, not not-found, for a malformed stored row", async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("p2p-speedtest", 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("results");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("results", "readwrite");
      tx.objectStore("results").add({ not: "a valid envelope" }, [ROOM, PEER_A]);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });

    const outcome = await getResult(ROOM, PEER_A);
    expect(outcome.status).toBe("invalid");
  });
});

describe("buildExportBundle", () => {
  it("bundles every stored result by default", async () => {
    await saveResult(await makeResult(PEER_A));
    await saveResult(await makeResult(PEER_B));

    const outcome = await buildExportBundle();
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") expect(outcome.bundle.results).toHaveLength(2);
  });

  it("bundles only the requested identities when keys are given", async () => {
    const a = await makeResult(PEER_A);
    await saveResult(a);
    await saveResult(await makeResult(PEER_B));

    const outcome = await buildExportBundle([[ROOM, PEER_A]]);
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") expect(outcome.bundle.results).toEqual([a]);
  });
});

describe("buildResultCopyText", () => {
  it("names an absent group as not measured rather than omitting it", async () => {
    const failed = await makeResult(PEER_A);
    const text = buildResultCopyText({ ...failed.data, bandwidth: { directional: failed.data.bandwidth.directional } });
    expect(text).toContain("Duplex: not measured");
    expect(text).toContain(`Connection: ${failed.data.via}`);
  });
});

describe("importResults", () => {
  function file(body: unknown): File {
    return new File([JSON.stringify(body)], "export.json", { type: "application/json" });
  }

  it("rejects a file whose outer shape isn't { results: [...] }", async () => {
    expect(await importResults(file({ nope: true }))).toEqual({ status: "malformed-file" });
    expect(await importResults(new File(["not json"], "export.json"))).toEqual({
      status: "malformed-file",
    });
  });

  it("saves a valid entry and reports it", async () => {
    const good = await makeResult(PEER_A);
    const outcome = await importResults(file({ results: [good] }));
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.entries).toEqual([{ index: 0, outcome: { status: "saved" } }]);
    }
    expect(await getResult(ROOM, PEER_A)).toEqual({ status: "ok", result: good });
  });

  it("reports deduplication for an entry already in storage", async () => {
    const good = await makeResult(PEER_A);
    await saveResult(good);

    const outcome = await importResults(file({ results: [good] }));
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.entries).toEqual([{ index: 0, outcome: { status: "deduplicated" } }]);
    }
  });

  it("skips an entry with missing/malformed apiVersion or kind, by itself", async () => {
    const good = await makeResult(PEER_A);
    const broken = { ...(await makeResult(PEER_B)), apiVersion: undefined };
    const outcome = await importResults(file({ results: [broken, good] }));
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.entries[0]).toEqual({
        index: 0,
        outcome: { status: "malformed", message: "missing or malformed apiVersion/kind" },
      });
      expect(outcome.entries[1]).toEqual({ index: 1, outcome: { status: "saved" } });
    }
    // The one bad entry never aborted the good one.
    expect(await getResult(ROOM, PEER_A)).toMatchObject({ status: "ok" });
  });

  it("skips an entry with an unsupported apiVersion, naming the version found", async () => {
    const wrongVersion = { ...(await makeResult(PEER_A)), apiVersion: "sws.aries0d0f.me/v2" };
    const outcome = await importResults(file({ results: [wrongVersion] }));
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.entries).toEqual([
        {
          index: 0,
          outcome: {
            status: "unsupported-version",
            message: "entry uses sws.aries0d0f.me/v2, not supported by this version",
          },
        },
      ]);
    }
    expect(await getResult(ROOM, PEER_A)).toEqual({ status: "not-found" });
  });

  it("rejects an entry that passes schema but fails data semantics", async () => {
    const entry = await makeResult(PEER_A);
    // Same-peer edge: schema-valid shape, semantically invalid (S6's "from
    // and to must differ").
    (entry.data.bandwidth.directional as any)[0] = {
      from: PEER_A,
      to: PEER_A,
      speed: 1,
      latency: 1,
      jitter: 1,
      loss: 0,
    };
    entry.metadata.hash = await computeResultHash(entry.data);
    const outcome = await importResults(file({ results: [entry] }));
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.entries[0].outcome.status).toBe("invalid");
    }
  });

  it("rejects an entry whose checksum doesn't match its data, with a corruption message", async () => {
    const entry = await makeResult(PEER_A);
    entry.metadata.hash = "0".repeat(64);
    const outcome = await importResults(file({ results: [entry] }));
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      const result = outcome.entries[0].outcome;
      expect(result.status).toBe("invalid");
      if (result.status === "invalid") {
        expect(result.errors.some((e) => e.includes("corrupted"))).toBe(true);
      }
    }
  });

  it("rejects an entry whose metadata.peer-id was edited while data is untouched, even though the checksum still matches", async () => {
    const entry = await makeResult(PEER_A);
    // The checksum covers `data` only, so rewriting metadata.peer-id alone
    // leaves it intact — the identity check is what must catch this (5.4b).
    entry.metadata["peer-id"] = "8a4d2b91-7c3e-5f1a-b6d8-2e9f4c7a1b99";
    const outcome = await importResults(file({ results: [entry] }));
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      const result = outcome.entries[0].outcome;
      expect(result.status).toBe("invalid");
      if (result.status === "invalid") {
        expect(result.errors.some((e) => e.includes("peer-id"))).toBe(true);
      }
    }
  });
});
