/**
 * Local result history (4.3b). One `P2PSpeedtestResult` envelope per
 * `metadata.peer-id` + `data.room` (S7), stored in IndexedDB rather than a
 * single shared `localStorage` array so each identity gets a real
 * transaction and independent key, and two same-origin tabs never race a
 * shared read/modify/write.
 */

import type { GeoInfo } from "./geo";
import { fallbackPeerName } from "./peer-profile";
import { validateEnvelope } from "./result-validate";
import { DUPLEX, senderSlotFor, type Slot, type StageBankEntry } from "./stage";

export type ResultStatus = "SUCCEED" | "FAILED" | "CANCELED";
export type ViaType = "DIRECT" | "RELAY" | "UNKNOWN";

export interface ResultPeer {
  id: string;
  name: string;
  ua?: string;
  ip?: string;
  protocol?: "IPv4" | "IPv6";
  geo?: GeoInfo;
}

export interface BandwidthEdge {
  from: string;
  to: string;
  speed: number;
  latency: number;
  jitter: number;
  loss: number;
}

export interface ResultData {
  room: string;
  status: ResultStatus;
  timestamp: string;
  peers: [ResultPeer, ResultPeer];
  bandwidth: { directional?: BandwidthEdge[]; duplex?: BandwidthEdge[] };
  via: ViaType;
}

export interface ResultMetadata {
  id: string;
  "peer-id": string;
  hash: string;
}

export interface P2PSpeedtestResult {
  apiVersion: "sws.aries0d0f.me/v1";
  kind: "P2PSpeedtestResult";
  metadata: ResultMetadata;
  data: ResultData;
}

export function buildMetadata(roomId: string, peerId: string, hash: string): ResultMetadata {
  return { id: roomId, "peer-id": peerId, hash };
}

// --- Assembly (4.4) ---------------------------------------------------

export interface AssemblePeerInfo {
  slot: Slot;
  peerId: string;
  /** `null` when this peer's profile never arrived — `buildResultPeer`
   * falls back to a slot-based name (S6) rather than producing an
   * unstorable record. */
  profile: {
    name: string;
    ua?: string;
    ip?: string;
    protocol?: "IPv4" | "IPv6";
    geo?: GeoInfo;
  } | null;
}

function buildResultPeer(peer: AssemblePeerInfo): ResultPeer {
  if (!peer.profile) return { id: peer.peerId, name: fallbackPeerName(peer.slot) };
  const { name, ua, ip, protocol, geo } = peer.profile;
  return {
    id: peer.peerId,
    name,
    ...(ua ? { ua } : {}),
    ...(ip ? { ip } : {}),
    ...(protocol ? { protocol } : {}),
    ...(geo ? { geo } : {}),
  };
}

function buildBandwidthEdge(entry: StageBankEntry, idBySlot: (slot: Slot) => string): BandwidthEdge {
  const { bytes, durationMs, latency, jitter, chunksSeen, chunksExpected } = entry.measurement;
  return {
    from: idBySlot(senderSlotFor(entry.receiverSlot)),
    to: idBySlot(entry.receiverSlot),
    speed: durationMs > 0 ? (bytes * 8) / (durationMs / 1000) : 0,
    latency,
    jitter,
    loss: chunksExpected > 0 ? 1 - chunksSeen / chunksExpected : 0,
  };
}

export interface AssembleInput {
  room: string;
  timestamp: string;
  status: ResultStatus;
  via: ViaType;
  /** Both peers, in any order — sorted by slot here so assembly is
   * deterministic regardless of which peer is "me" (4.4, S6). */
  peers: [AssemblePeerInfo, AssemblePeerInfo];
  /** The merged edge set: the shared, acknowledged stage bank plus any
   * locally sealed but unacknowledged current-stage edge and anything
   * merged in from the peer's terminal `result-share`. */
  bank: StageBankEntry[];
}

/**
 * Deterministic record assembly (4.4's "Assembling the record"): peers and
 * edges ordered by slot, `speed`/`loss` computed from raw counts, and
 * `from`/`to` derived from the fixed stage roles rather than trusted from
 * either peer. Two peers assembling from the same frozen bank and shares
 * produce byte-identical `data` — this is what a checksum comparison
 * actually verifies.
 */
export function assembleResult(input: AssembleInput): ResultData {
  const sortedPeers = [...input.peers].sort((a, b) => a.slot - b.slot);
  const idBySlot = (slot: Slot): string => sortedPeers.find((p) => p.slot === slot)!.peerId;
  const peers: [ResultPeer, ResultPeer] = [
    buildResultPeer(sortedPeers[0]),
    buildResultPeer(sortedPeers[1]),
  ];

  const bySlot = (a: StageBankEntry, b: StageBankEntry) => a.receiverSlot - b.receiverSlot;
  const directional = input.bank
    .filter((e) => e.stageId !== DUPLEX)
    .sort(bySlot)
    .map((e) => buildBandwidthEdge(e, idBySlot));
  const duplex = input.bank
    .filter((e) => e.stageId === DUPLEX)
    .sort(bySlot)
    .map((e) => buildBandwidthEdge(e, idBySlot));

  return {
    room: input.room,
    status: input.status,
    timestamp: input.timestamp,
    peers,
    bandwidth: {
      ...(directional.length > 0 ? { directional } : {}),
      ...(duplex.length > 0 ? { duplex } : {}),
    },
    via: input.via,
  };
}

// --- IndexedDB storage -------------------------------------------------

const DB_NAME = "p2p-speedtest";
const DB_VERSION = 1;
const STORE_NAME = "results";

/** Compound out-of-line key: `data.room` + `metadata["peer-id"]` (S7's
 * identity). The store has no inline key path, so the key always travels
 * alongside the value rather than being derived from it. */
function keyFor(result: P2PSpeedtestResult): [string, string] {
  return [result.data.room, result.metadata["peer-id"]];
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export type SaveResultOutcome =
  | { status: "saved" }
  | { status: "deduplicated" }
  | { status: "error"; reason: "open-failed" | "transaction-failed" | "quota-exceeded" };

/**
 * Owns deduplication itself — no caller checks first. One `readwrite`
 * transaction calls `add`; an `add` `ConstraintError` means that identity
 * already exists, and its handler prevents that expected request error from
 * aborting the transaction rather than treating it as a real failure.
 * Nothing here ever calls `put`: the first write for an identity always
 * wins, exactly once (4.3b, S7).
 */
export async function saveResult(result: P2PSpeedtestResult): Promise<SaveResultOutcome> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    // Do not delete/recreate the database — leave existing data untouched
    // and report a structured failure instead.
    return { status: "error", reason: "open-failed" };
  }

  return new Promise((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE_NAME, "readwrite");
    } catch {
      resolve({ status: "error", reason: "transaction-failed" });
      return;
    }

    let outcome: SaveResultOutcome = { status: "saved" };
    const addReq = tx.objectStore(STORE_NAME).add(result, keyFor(result));

    addReq.onerror = (event) => {
      const name = addReq.error?.name;
      if (name === "ConstraintError") {
        // Expected: this identity was already saved (by this tab or
        // another). Not a failure — prevent the default abort and report
        // dedup without touching the existing first write.
        outcome = { status: "deduplicated" };
        event.preventDefault();
        return;
      }
      outcome =
        name === "QuotaExceededError"
          ? { status: "error", reason: "quota-exceeded" }
          : { status: "error", reason: "transaction-failed" };
      // Any other error is left to abort the transaction normally.
    };

    // Each call opens and closes its own connection rather than holding one
    // open across calls: nothing here depends on a long-lived connection,
    // and closing promptly is what lets versionchange/deleteDatabase (used
    // by tests, and by any future migration) proceed without blocking on a
    // idle handle from an unrelated call.
    tx.oncomplete = () => {
      db.close();
      resolve(outcome);
    };
    tx.onerror = () => {
      db.close();
      resolve(outcome.status === "saved" ? { status: "error", reason: "transaction-failed" } : outcome);
    };
    tx.onabort = () => {
      db.close();
      resolve(outcome.status === "saved" ? { status: "error", reason: "transaction-failed" } : outcome);
    };
  });
}

type RawRowsOutcome = unknown[] | { error: "open-failed" | "transaction-failed" };

async function getAllRaw(): Promise<RawRowsOutcome> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return { error: "open-failed" };
  }
  return new Promise((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE_NAME, "readonly");
    } catch {
      resolve({ error: "transaction-failed" });
      return;
    }
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => {
      const rows = req.result as unknown[];
      db.close();
      resolve(rows);
    };
    req.onerror = () => {
      db.close();
      resolve({ error: "transaction-failed" });
    };
  });
}

export type ListResultsOutcome =
  | { status: "ok"; results: P2PSpeedtestResult[]; warnings: string[] }
  | { status: "error"; reason: "open-failed" | "transaction-failed" };

/** Validates every stored entry on read. A malformed legacy/imported row is
 * skipped with a visible warning and left in the store untouched — never
 * deleted — for manual recovery; one bad row never wipes the rest. */
export async function listResults(): Promise<ListResultsOutcome> {
  const raw = await getAllRaw();
  if (!Array.isArray(raw)) return { status: "error", reason: raw.error };

  const results: P2PSpeedtestResult[] = [];
  const warnings: string[] = [];
  for (const entry of raw) {
    const validation = await validateEnvelope(entry);
    if (validation.valid) {
      results.push(entry as P2PSpeedtestResult);
    } else {
      const message = `Skipped a malformed stored result: ${validation.errors.join("; ")}`;
      warnings.push(message);
      console.warn(message);
    }
  }
  return { status: "ok", results, warnings };
}
