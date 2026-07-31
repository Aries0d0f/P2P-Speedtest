/** Outcomes of every local-storage operation on a result record (5.1–5.4).
 * Each is a discriminated union rather than a thrown error, so a caller has to
 * handle "not found" and "corrupted" as the distinct facts they are. */

import type { P2PSpeedtestResult } from "./result.model";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

type StorageFailure = "open-failed" | "transaction-failed";

export type SaveResultOutcome =
  | { status: "saved" }
  | { status: "deduplicated" }
  | { status: "error"; reason: StorageFailure | "quota-exceeded" };

export type ListResultsOutcome =
  | { status: "ok"; results: P2PSpeedtestResult[]; warnings: string[] }
  | { status: "error"; reason: StorageFailure };

export type GetResultOutcome =
  | { status: "ok"; result: P2PSpeedtestResult }
  | { status: "not-found" }
  | { status: "invalid"; errors: string[] }
  | { status: "error"; reason: StorageFailure };

/** No separate top-level version wrapper: every entry already carries its own
 * `apiVersion` (5.3). */
export interface ExportBundle {
  results: P2PSpeedtestResult[];
}

export type BuildExportOutcome =
  | { status: "ok"; bundle: ExportBundle }
  | { status: "error"; reason: StorageFailure };

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
