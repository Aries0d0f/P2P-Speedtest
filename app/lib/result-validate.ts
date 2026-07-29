/**
 * Validation foundation for the result record (4.3b). Layered by what each
 * consumer can actually check:
 *
 * - `validateData` — schema validation of `data` plus the semantic
 *   invariants over it. This is what an assembling peer calls (4.4);
 *   at that moment there is no `metadata` and no hash yet.
 * - `validateEnvelope` — the full record: `validateData` plus
 *   `apiVersion`/`kind`, `metadata.id === data.room`,
 *   `metadata.peer-id` appearing exactly once in `data.peers`, and the
 *   checksum. Phase 5's import calls this.
 *
 * Both peers and Phase 5's import path rest on the schema staying the
 * single source of truth: it is converted from YAML to JSON, and its Ajv
 * validators precompiled to standalone JS, at build time
 * (`scripts/build-schema.mjs`) — neither the Worker nor the browser parses
 * YAML or runs Ajv's own `new Function`-based `compile()` at runtime.
 * Standalone compilation isn't just an optimization here: Cloudflare
 * Workers' runtime refuses dynamic code generation outright ("Code
 * generation from strings disallowed"), so the normal `ajv.compile()` path
 * cannot run in this app at all.
 */

import { computeResultHash } from "./result-hash";
// Exposed for introspection/tooling (e.g. Phase 5) — validation itself
// uses the precompiled functions below, not this raw document.
import p2pSpeedtestResultV1Schema from "./generated/p2p-speedtest-result.v1.schema.json";
import {
  validateData as validateDataSchema,
  validateEnvelope as validateEnvelopeSchema,
  type AjvValidateFn,
} from "./generated/p2p-speedtest-result.v1.schema.validators.js";

export { p2pSpeedtestResultV1Schema };

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function ok(): ValidationResult {
  return { valid: true, errors: [] };
}

function fail(...errors: string[]): ValidationResult {
  return { valid: false, errors };
}

function schemaErrors(errors: AjvValidateFn["errors"]): string[] {
  if (!errors) return [];
  return errors.map((e) => `${e.instancePath || "<root>"} ${e.message ?? "invalid"}`);
}

interface BandwidthEdge {
  from: string;
  to: string;
  speed: number;
  latency: number;
  jitter: number;
  loss: number;
}

interface Peer {
  id: string;
  name: string;
}

interface ResultData {
  room: string;
  status: "SUCCEED" | "FAILED" | "CANCELED";
  timestamp: string;
  peers: Peer[];
  bandwidth?: { directional?: BandwidthEdge[]; duplex?: BandwidthEdge[] };
  via: "DIRECT" | "RELAY" | "UNKNOWN";
}

function validateEdgeGroup(
  label: string,
  edges: BandwidthEdge[] | undefined,
  knownPeerIds: ReadonlySet<string>,
  errors: string[],
): void {
  if (!edges) return;
  for (const edge of edges) {
    if (!knownPeerIds.has(edge.from) || !knownPeerIds.has(edge.to)) {
      errors.push(`${label}: edge endpoint is not a known peer (${edge.from} -> ${edge.to})`);
    }
    if (edge.from === edge.to) {
      errors.push(`${label}: edge from and to are the same peer (${edge.from})`);
    }
  }
  if (edges.length === 2) {
    const [a, b] = edges;
    if (a.from !== b.to || a.to !== b.from || a.from === b.from) {
      errors.push(`${label}: two-edge group is not a proper reverse pair`);
    }
  }
}

/**
 * Schema-validates `data` and checks the semantic invariants over it:
 * `data.room === roomId`, exactly two unique peer ids, every edge endpoint
 * a known peer with `from !== to`, and a two-edge group forming a proper
 * reverse pair. `SUCCEED` requiring both groups full is already enforced by
 * the schema's own conditional.
 */
export function validateData(data: unknown, roomId: string): ValidationResult {
  const schemaValid = validateDataSchema(data);
  if (!schemaValid) return fail(...schemaErrors(validateDataSchema.errors));

  const value = data as ResultData;
  const errors: string[] = [];

  if (value.room !== roomId) {
    errors.push(`data.room (${value.room}) does not match the expected room (${roomId})`);
  }

  const peerIds = value.peers.map((p) => p.id);
  const uniqueIds = new Set(peerIds);
  if (peerIds.length !== 2 || uniqueIds.size !== 2) {
    errors.push("data.peers must contain exactly two unique peer ids");
  }

  validateEdgeGroup("bandwidth.directional", value.bandwidth?.directional, uniqueIds, errors);
  validateEdgeGroup("bandwidth.duplex", value.bandwidth?.duplex, uniqueIds, errors);

  return errors.length > 0 ? fail(...errors) : ok();
}

interface Envelope {
  apiVersion: string;
  kind: string;
  metadata: { id: string; "peer-id": string; hash: string };
  data: ResultData;
}

/**
 * The full envelope check Phase 5's import performs: schema validation of
 * the whole record (which covers `apiVersion`/`kind`/`metadata` shape),
 * `validateData` against `metadata.id` as the expected room,
 * `metadata.peer-id` appearing exactly once in `data.peers`, and that the
 * stored `hash` matches a fresh `computeResultHash(data)`.
 */
export async function validateEnvelope(entry: unknown): Promise<ValidationResult> {
  const schemaValid = validateEnvelopeSchema(entry);
  if (!schemaValid) return fail(...schemaErrors(validateEnvelopeSchema.errors));

  const value = entry as Envelope;
  const dataResult = validateData(value.data, value.metadata.id);
  const errors = [...dataResult.errors];

  const ownerId = value.metadata["peer-id"];
  const occurrences = value.data.peers.filter((p) => p.id === ownerId).length;
  if (occurrences !== 1) {
    errors.push(`metadata.peer-id must appear exactly once in data.peers (found ${occurrences})`);
  }

  const expectedHash = await computeResultHash(value.data);
  if (expectedHash !== value.metadata.hash) {
    errors.push("metadata.hash does not match the checksum of data");
  }

  return errors.length > 0 ? fail(...errors) : ok();
}
