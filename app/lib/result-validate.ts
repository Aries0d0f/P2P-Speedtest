/**
 * Validation for the result record (4.3b), layered by what each consumer can
 * check: `validateData` is what an assembling peer calls, before there is any
 * `metadata` or hash; `validateEnvelope` adds those plus the checksum.
 *
 * The schema is the single source of truth, compiled to standalone Ajv
 * validators at build time. That is not an optimization: the Workers runtime
 * refuses dynamic code generation outright, so Ajv's own `compile()` cannot
 * run in this app at all.
 */

import { computeResultHash } from "./result-hash";
import type {
  BandwidthEdge,
  P2PSpeedtestResult,
  ResultData,
} from "~/model/result.model";
import type { ValidationResult } from "~/model/storage.model";
// Exposed for introspection/tooling (e.g. Phase 5) — validation itself
// uses the precompiled functions below, not this raw document.
import p2pSpeedtestResultV1Schema from "./generated/p2p-speedtest-result.v1.schema.json";
import {
  validateData as validateDataSchema,
  validateEnvelope as validateEnvelopeSchema,
  type AjvValidateFn,
} from "./generated/p2p-speedtest-result.v1.schema.validators.js";

export { p2pSpeedtestResultV1Schema };

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

/** Schema plus the semantic invariants over it: matching room, two unique
 * peer ids, every edge endpoint a known peer with `from !== to`, and a
 * two-edge group forming a proper reverse pair. */
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

/** `validateData` against `metadata.id` as the expected room, plus
 * `metadata.peer-id` appearing exactly once in `data.peers` and a matching
 * checksum. */
export async function validateEnvelope(entry: unknown): Promise<ValidationResult> {
  const schemaValid = validateEnvelopeSchema(entry);
  if (!schemaValid) return fail(...schemaErrors(validateEnvelopeSchema.errors));

  const value = entry as P2PSpeedtestResult;
  const dataResult = validateData(value.data, value.metadata.id);
  const errors = [...dataResult.errors];

  const ownerId = value.metadata["peer-id"];
  const occurrences = value.data.peers.filter((p) => p.id === ownerId).length;
  if (occurrences !== 1) {
    errors.push(`metadata.peer-id must appear exactly once in data.peers (found ${occurrences})`);
  }

  // Phrased as corruption, not provenance (S6, 5.4): a matching checksum
  // never establishes that a record was produced by this app, so a mismatch
  // must not be read as "not produced by this app" either — only as damage.
  const expectedHash = await computeResultHash(value.data);
  if (expectedHash !== value.metadata.hash) {
    errors.push("metadata.hash checksum mismatch — this entry is corrupted");
  }

  return errors.length > 0 ? fail(...errors) : ok();
}
