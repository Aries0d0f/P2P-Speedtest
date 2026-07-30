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

/** bits per second → Mbps, one decimal place. The only transformation
 * Phase 5's UI is permitted to apply to a stored bandwidth edge (5.2) —
 * everything else renders the schema's own fields as-is. */
export function bpsToMbps(bitsPerSecond: number): string {
  return (bitsPerSecond / 1_000_000).toFixed(1);
}

function edgeLine(edge: BandwidthEdge): string {
  return `${bpsToMbps(edge.speed)} Mbps · ${edge.latency.toFixed(0)} ms · loss ${(edge.loss * 100).toFixed(2)}%`;
}

/**
 * Shared copy-text builder for the room page's result state and the
 * results detail page (5.5). Always names `data.via` and both bandwidth
 * groups: an absent group reads as "not measured" rather than being
 * omitted or printed as a zero, so a partial `FAILED`/`CANCELED` record
 * never reads as a complete result with suspiciously few numbers.
 */
export function buildResultCopyText(data: ResultData): string {
  const lines: string[] = [`P2P Speedtest result — ${data.status}`, `Connection: ${data.via}`];

  for (const [label, edges] of [
    ["Directional", data.bandwidth.directional],
    ["Duplex", data.bandwidth.duplex],
  ] as const) {
    if (!edges || edges.length === 0) {
      lines.push(`${label}: not measured`);
      continue;
    }
    lines.push(`${label}:`);
    for (const edge of edges) lines.push(`  ${edgeLine(edge)}`);
  }

  return lines.join("\n");
}

/**
 * A `/results/:room/:peerId` link (5.5). Resolves only in a browser that
 * already holds this exact record — export/import (5.3/5.4) is the actual
 * cross-device portability path, so callers must show the local-only
 * caveat alongside this rather than implying the link travels.
 */
export function buildResultLink(origin: string, room: string, peerId: string): string {
  return `${origin}/results/${room}/${peerId}`;
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

export type GetResultOutcome =
  | { status: "ok"; result: P2PSpeedtestResult }
  | { status: "not-found" }
  | { status: "invalid"; errors: string[] }
  | { status: "error"; reason: "open-failed" | "transaction-failed" };

async function getRaw(
  room: string,
  peerId: string,
): Promise<{ found: false } | { found: true; value: unknown } | { error: "open-failed" | "transaction-failed" }> {
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
    const req = tx.objectStore(STORE_NAME).get([room, peerId]);
    req.onsuccess = () => {
      const value = req.result as unknown;
      db.close();
      resolve(value === undefined ? { found: false } : { found: true, value });
    };
    req.onerror = () => {
      db.close();
      resolve({ error: "transaction-failed" });
    };
  });
}

/** Reads the single record for `[room, peerId]` — the out-of-line compound
 * key every row is stored under (5.1). A record missing from this browser's
 * store is `not-found`, never a crash; a present-but-malformed row is
 * `invalid` rather than silently treated as absent, so the detail route can
 * tell the two apart. */
export async function getResult(room: string, peerId: string): Promise<GetResultOutcome> {
  const raw = await getRaw(room, peerId);
  if ("error" in raw) return { status: "error", reason: raw.error };
  if (!raw.found) return { status: "not-found" };
  const validation = await validateEnvelope(raw.value);
  if (!validation.valid) return { status: "invalid", errors: validation.errors };
  return { status: "ok", result: raw.value as P2PSpeedtestResult };
}

// --- Export (5.3) -------------------------------------------------------

export interface ExportBundle {
  results: P2PSpeedtestResult[];
}

export type BuildExportOutcome =
  | { status: "ok"; bundle: ExportBundle }
  | { status: "error"; reason: "open-failed" | "transaction-failed" };

/** Builds the `{ results: [...] }` export shape — no separate top-level
 * version wrapper, since every entry already carries its own `apiVersion`
 * (5.3). Pure data assembly, kept apart from `downloadExportBundle` so it
 * can be exercised without a DOM. */
export async function buildExportBundle(keys?: Array<[string, string]>): Promise<BuildExportOutcome> {
  const listed = await listResults();
  if (listed.status === "error") return listed;
  if (!keys) return { status: "ok", bundle: { results: listed.results } };

  const wanted = new Set(keys.map(([room, peerId]) => `${room} ${peerId}`));
  const results = listed.results.filter((r) => wanted.has(`${r.data.room} ${r.metadata["peer-id"]}`));
  return { status: "ok", bundle: { results } };
}

/** Triggers a browser download of an already-built bundle. Never called
 * outside a browser context. */
export function downloadExportBundle(bundle: ExportBundle): void {
  const blob = new Blob([JSON.stringify(bundle)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = "p2p-speedtest-results.json";
    a.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** All results by default, or a selection if `keys` names specific
 * `[room, peerId]` identities (5.3). */
export async function exportResults(keys?: Array<[string, string]>): Promise<BuildExportOutcome> {
  const outcome = await buildExportBundle(keys);
  if (outcome.status === "ok") downloadExportBundle(outcome.bundle);
  return outcome;
}

// --- Import (5.4) --------------------------------------------------------

const SUPPORTED_API_VERSION = "sws.aries0d0f.me/v1";

export type ImportEntryOutcome =
  | { status: "saved" }
  | { status: "deduplicated" }
  | { status: "malformed"; message: string }
  | { status: "unsupported-version"; message: string }
  | { status: "invalid"; errors: string[] }
  | { status: "save-error"; reason: string };

export interface ImportEntryResult {
  index: number;
  outcome: ImportEntryOutcome;
}

export type ImportResultsOutcome =
  | { status: "malformed-file" }
  | { status: "ok"; entries: ImportEntryResult[] };

function hasStringApiVersionAndKind(value: unknown): value is { apiVersion: string; kind: string } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.apiVersion === "string" && typeof v.kind === "string";
}

/**
 * Imports an exported `{ results: [...] }` file (5.4). The outer shape is
 * the only fatal case — a malformed or missing `results` array aborts
 * before touching storage. Every entry inside it is then handled
 * independently, in order: a missing/malformed `apiVersion`/`kind` is
 * skipped as malformed, an unsupported `apiVersion` is skipped by name
 * (never coerced into this version's shape), and everything else goes
 * through `validateEnvelope` — schema, semantics, identity, then checksum —
 * before `saveResult` applies Phase 4's transactional first-write-wins
 * merge. One bad entry never aborts the rest of the file.
 */
export async function importResults(file: File): Promise<ImportResultsOutcome> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    return { status: "malformed-file" };
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as Record<string, unknown>).results)
  ) {
    return { status: "malformed-file" };
  }

  const rawEntries = (parsed as { results: unknown[] }).results;
  const entries: ImportEntryResult[] = [];

  for (let index = 0; index < rawEntries.length; index++) {
    const entry = rawEntries[index];

    if (!hasStringApiVersionAndKind(entry)) {
      entries.push({ index, outcome: { status: "malformed", message: "missing or malformed apiVersion/kind" } });
      continue;
    }
    if (entry.apiVersion !== SUPPORTED_API_VERSION) {
      entries.push({
        index,
        outcome: {
          status: "unsupported-version",
          message: `entry uses ${entry.apiVersion}, not supported by this version`,
        },
      });
      continue;
    }

    const validation = await validateEnvelope(entry);
    if (!validation.valid) {
      entries.push({ index, outcome: { status: "invalid", errors: validation.errors } });
      continue;
    }

    const saveOutcome = await saveResult(entry as P2PSpeedtestResult);
    if (saveOutcome.status === "error") {
      entries.push({ index, outcome: { status: "save-error", reason: saveOutcome.reason } });
    } else {
      entries.push({ index, outcome: { status: saveOutcome.status } });
    }
  }

  return { status: "ok", entries };
}
