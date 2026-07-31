/**
 * The one decoder for the control channel.
 *
 * Every branch below is the accept/reject rule for its own type, unchanged
 * from when they lived in three separate decoders: a malformed message, a
 * stale/foreign `runId`, or a type outside the vocabulary all yield `null`, so
 * no caller ever has to trust what an untrusted peer sent.
 */

import {
  CONTROL_MESSAGE_TYPES,
  type ControlMessage,
  type ControlMessageType,
} from "~/model/control-message.model";
import { isValidMeasurement, type LatencyAggregate } from "~/model/measurement.model";
import { isConnectionType } from "~/model/connection.model";
import { isSlot, isStageId } from "~/model/stage.model";
import type { ResultShare } from "~/model/result.model";

function isKnownControlType(value: unknown): value is ControlMessageType {
  return typeof value === "string" && (CONTROL_MESSAGE_TYPES as readonly string[]).includes(value);
}

function isFiniteNonNegNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** `undefined` means "reject"; `null` is the honest "measured, but too few
 * samples" value a peer is allowed to send. */
function extractAggregate(payload: unknown): LatencyAggregate | null | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const value = payload as Record<string, unknown>;
  if (value.aggregate === null) return null;
  const agg = value.aggregate;
  if (typeof agg !== "object" || agg === null) return undefined;
  const a = agg as Record<string, unknown>;
  if (
    typeof a.rttMs !== "number" ||
    typeof a.jitterMs !== "number" ||
    !Number.isFinite(a.rttMs) ||
    !Number.isFinite(a.jitterMs)
  ) {
    return undefined;
  }
  return { rttMs: a.rttMs, jitterMs: a.jitterMs };
}

export function decodeControlMessage(data: unknown, runId: string): ControlMessage | null {
  if (typeof data !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const v = parsed as Record<string, unknown>;

  if (!isKnownControlType(v.type)) return null;
  if (v.runId !== runId) return null;

  switch (v.type) {
    case "channel-ready":
      return { runId, type: "channel-ready", payload: {} };

    case "ping":
    case "pong": {
      if (!isNonNegInteger(v.seq)) return null;
      return { runId, type: v.type, seq: v.seq, payload: {} };
    }

    case "latency-ready": {
      const aggregate = extractAggregate(v.payload);
      if (aggregate === undefined) return null;
      return { runId, type: "latency-ready", payload: { aggregate } };
    }

    case "stage-prepare":
    case "stage-armed":
    case "stage-start": {
      if (!isStageId(v.stageId)) return null;
      return { runId, type: v.type, stageId: v.stageId, payload: {} };
    }

    case "stage-complete": {
      if (!isStageId(v.stageId)) return null;
      if (typeof v.payload !== "object" || v.payload === null) return null;
      const p = v.payload as Record<string, unknown>;
      let sentMeasuredChunks: number | undefined;
      if (p.sentMeasuredChunks !== undefined) {
        if (!isNonNegInteger(p.sentMeasuredChunks)) return null;
        sentMeasuredChunks = p.sentMeasuredChunks;
      }
      return { runId, type: "stage-complete", stageId: v.stageId, payload: { sentMeasuredChunks } };
    }

    case "measurement-progress": {
      if (!isStageId(v.stageId) || !isSlot(v.receiverSlot)) return null;
      if (!isNonNegInteger(v.progressSeq)) return null;
      if (typeof v.payload !== "object" || v.payload === null) return null;
      const p = v.payload as Record<string, unknown>;
      if (
        !isFiniteNonNegNumber(p.elapsedMs) ||
        !isFiniteNonNegNumber(p.bytes) ||
        !isFiniteNonNegNumber(p.chunksSeen) ||
        !isFiniteNonNegNumber(p.highestSeqPlusOne)
      ) {
        return null;
      }
      return {
        runId,
        type: "measurement-progress",
        stageId: v.stageId,
        receiverSlot: v.receiverSlot,
        progressSeq: v.progressSeq,
        payload: {
          elapsedMs: p.elapsedMs,
          bytes: p.bytes,
          chunksSeen: p.chunksSeen,
          highestSeqPlusOne: p.highestSeqPlusOne,
        },
      };
    }

    case "stage-result": {
      if (!isStageId(v.stageId) || !isSlot(v.receiverSlot)) return null;
      if (typeof v.payload !== "object" || v.payload === null) return null;
      const measurement = (v.payload as Record<string, unknown>).measurement;
      if (!isValidMeasurement(measurement)) return null;
      return {
        runId,
        type: "stage-result",
        stageId: v.stageId,
        receiverSlot: v.receiverSlot,
        payload: { measurement },
      };
    }

    case "stage-result-ack": {
      if (!isStageId(v.stageId) || !isSlot(v.receiverSlot)) return null;
      return {
        runId,
        type: "stage-result-ack",
        stageId: v.stageId,
        receiverSlot: v.receiverSlot,
        payload: {},
      };
    }

    case "test-abort": {
      if (typeof v.payload !== "object" || v.payload === null) return null;
      const p = v.payload as Record<string, unknown>;
      if (p.status !== "FAILED" && p.status !== "CANCELED") return null;
      if (typeof p.reason !== "string" || p.reason.length === 0) return null;
      return { runId, type: "test-abort", payload: { status: p.status, reason: p.reason } };
    }

    case "result-share": {
      if (typeof v.payload !== "object" || v.payload === null) return null;
      const p = v.payload as Record<string, unknown>;
      if (p.status === "SUCCEED") {
        if (
          !isValidMeasurement(p.directional) ||
          !isValidMeasurement(p.duplex) ||
          !isConnectionType(p.via)
        ) {
          return null;
        }
        return {
          runId,
          type: "result-share",
          payload: { status: "SUCCEED", directional: p.directional, duplex: p.duplex, via: p.via },
        };
      }
      if (p.status === "FAILED" || p.status === "CANCELED") {
        if (typeof p.reason !== "string" || p.reason.length === 0) return null;
        const out: Extract<ResultShare, { reason: string }> = { status: p.status, reason: p.reason };
        if (p.directional !== undefined) {
          if (!isValidMeasurement(p.directional)) return null;
          out.directional = p.directional;
        }
        if (p.duplex !== undefined) {
          if (!isValidMeasurement(p.duplex)) return null;
          out.duplex = p.duplex;
        }
        if (p.via !== undefined) {
          if (!isConnectionType(p.via)) return null;
          out.via = p.via;
        }
        return { runId, type: "result-share", payload: out };
      }
      return null;
    }

    case "peer-profile":
      return { runId, type: "peer-profile", payload: v.payload };
  }
}

export function encodeControlMessage(msg: ControlMessage): string {
  return JSON.stringify(msg);
}
