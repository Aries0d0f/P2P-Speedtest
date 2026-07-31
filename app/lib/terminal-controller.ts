/**
 * The one run-scoped, idempotent finalization FSM (4.4).
 *
 * Every trigger — clean completion, local cancel/failure, a remote abort, or a
 * remote `run-ended` — joins the same promise: only the first call starts it,
 * and every later call contributes its status/reason to the reduction before
 * returning the same outcome.
 */

import { encodeControlMessage } from "./control-message";
import type { Slot } from "~/model/signaling.model";
import type { Measurement, StageBankEntry } from "~/model/measurement.model";
import { DOWNLOAD, DUPLEX, UPLOAD, edgeKey, otherSlot } from "~/model/stage.model";
import type { ConnectionType } from "~/model/connection.model";
import { assembleResult, saveResult } from "./results-store";
import {
  buildMetadata,
  type P2PSpeedtestResult,
  type ResultShare,
  type ResultStatus,
} from "~/model/result.model";
import { validateData } from "./result-validate";
import { computeResultHash } from "./result-hash";
import type { PeerWithProfile } from "~/model/peer.model";
import type { FinalizeTrigger, TerminalOutcome } from "~/model/room.model";

export interface TerminalControllerOptions {
  runId: string;
  room: string;
  timestamp: string;
  selfSlot: Slot;
  selfPeerId: string;
  send: (raw: string) => void;
  /** Freezes the stage orchestrator and returns its bank snapshot — called
   * exactly once, as the very first ordered action (4.4 step 1). */
  freezeStages: () => StageBankEntry[];
  getConnectionType: () => ConnectionType;
  getPeers: () => [PeerWithProfile, PeerWithProfile];
}

const PEER_SHARE_TIMEOUT_MS = 5_000;
const STATUS_RANK: Record<ResultStatus, number> = { SUCCEED: 0, CANCELED: 1, FAILED: 2 };

function moreSevere(a: ResultStatus, b: ResultStatus): ResultStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

export class TerminalController {
  private readonly opts: TerminalControllerOptions;
  private reducedStatus: ResultStatus = "SUCCEED";
  private reducedReason: string | null = null;
  private runPromise: Promise<TerminalOutcome> | null = null;
  private peerShare: ResultShare | null = null;
  private resolvePeerShareWait: (() => void) | null = null;

  constructor(opts: TerminalControllerOptions) {
    this.opts = opts;
  }

  /** Joins (and if needed starts) the single finalization run. Safe to call
   * repeatedly and concurrently — every caller gets the same outcome. */
  trigger(t: FinalizeTrigger): Promise<TerminalOutcome> {
    const status: ResultStatus = t.kind === "clean" ? "SUCCEED" : t.kind === "remote-run-ended" ? "FAILED" : t.status;
    const reason = t.kind === "clean" ? null : t.reason;
    this.reducedStatus = moreSevere(this.reducedStatus, status);
    if (this.reducedReason === null && reason !== null) this.reducedReason = reason;

    if (!this.runPromise) this.runPromise = this.run();
    return this.runPromise;
  }

  /** A `result-share` from the peer, decoded elsewhere. Only the first is
   * kept — idempotent by construction, matching the "at most one share"
   * rule this exchange runs under. */
  handleResultShare(payload: ResultShare): void {
    if (this.peerShare) return;
    this.peerShare = payload;
    this.resolvePeerShareWait?.();
  }

  private async run(): Promise<TerminalOutcome> {
    // 1. Freeze first — before anything else touches shared state.
    const bank = this.opts.freezeStages();

    // 2. Propagate a local cancel/failure, if this is one.
    if (this.reducedStatus !== "SUCCEED") {
      this.sendRaw({
        runId: this.opts.runId,
        type: "test-abort",
        payload: { status: this.reducedStatus, reason: this.reducedReason ?? "unknown" },
      });
    }

    // 3. Send exactly one local share, then wait briefly for the peer's.
    const localVia = this.opts.getConnectionType();
    const localShare = this.buildLocalShare(bank, localVia);
    this.sendRaw({ runId: this.opts.runId, type: "result-share", payload: localShare });
    await this.waitForPeerShare();

    const finalStatus = moreSevere(localShare.status, this.peerShare?.status ?? "FAILED");
    const via = this.combineVia(localVia, this.peerShare?.via);
    const mergedBank = this.mergeShareIntoBank(bank, this.peerShare);

    // 4. Assemble, validate, hash, and make exactly one save attempt.
    const [a, b] = this.opts.getPeers();
    const data = assembleResult({
      room: this.opts.room,
      timestamp: this.opts.timestamp,
      status: finalStatus,
      via,
      peers: [a, b],
      bank: mergedBank,
    });
    const validation = validateData(data, this.opts.room);
    if (!validation.valid) {
      console.warn("TerminalController: assembled data failed validation", validation.errors);
      return { status: finalStatus, record: null, validation };
    }
    const hash = await computeResultHash(data);
    const record: P2PSpeedtestResult = {
      apiVersion: "sws.aries0d0f.me/v1",
      kind: "P2PSpeedtestResult",
      metadata: buildMetadata(this.opts.room, this.opts.selfPeerId, hash),
      data,
    };
    const saveOutcome = await saveResult(record);
    if (saveOutcome.status === "error") {
      console.warn("TerminalController: saveResult failed", saveOutcome.reason);
    }
    return { status: finalStatus, record, validation };
  }

  private buildLocalShare(bank: StageBankEntry[], via: ConnectionType): ResultShare {
    const selfSlot = this.opts.selfSlot;
    const directional = bank.find((e) => e.stageId !== DUPLEX && e.receiverSlot === selfSlot)?.measurement;
    const duplex = bank.find((e) => e.stageId === DUPLEX && e.receiverSlot === selfSlot)?.measurement;

    if (this.reducedStatus === "SUCCEED" && directional && duplex) {
      return { status: "SUCCEED", directional, duplex, via };
    }
    return {
      status: this.reducedStatus === "SUCCEED" ? "FAILED" : this.reducedStatus,
      reason: this.reducedReason ?? "incomplete-measurement",
      ...(directional ? { directional } : {}),
      ...(duplex ? { duplex } : {}),
      via,
    };
  }

  private combineVia(local: ConnectionType, peer: ConnectionType | undefined): ConnectionType {
    if (local === "RELAY" || peer === "RELAY") return "RELAY";
    if (local === "DIRECT" || peer === "DIRECT") return "DIRECT";
    return "UNKNOWN";
  }

  /** Terminal replay merged idempotently with the stage bank (4.2's
   * "Notes on the shape"): a value that conflicts with an already-banked
   * edge is a protocol failure and is dropped rather than overwriting it —
   * the already-acknowledged bank entry always wins. */
  private mergeShareIntoBank(bank: StageBankEntry[], peer: ResultShare | null): StageBankEntry[] {
    const map = new Map(bank.map((e) => [edgeKey(e.stageId, e.receiverSlot), e]));
    if (peer) {
      const peerSlot = otherSlot(this.opts.selfSlot);
      if (peer.directional) {
        const stageId = peerSlot === 1 ? DOWNLOAD : UPLOAD;
        const key = edgeKey(stageId, peerSlot);
        if (!map.has(key)) map.set(key, { stageId, receiverSlot: peerSlot, measurement: peer.directional });
      }
      if (peer.duplex) {
        const key = edgeKey(DUPLEX, peerSlot);
        if (!map.has(key)) map.set(key, { stageId: DUPLEX, receiverSlot: peerSlot, measurement: peer.duplex });
      }
    }
    return [...map.values()];
  }

  private async waitForPeerShare(): Promise<void> {
    if (this.peerShare) return;
    await new Promise<void>((resolve) => {
      this.resolvePeerShareWait = resolve;
      setTimeout(resolve, PEER_SHARE_TIMEOUT_MS);
    });
  }

  private sendRaw(msg: unknown): void {
    try {
      this.opts.send(JSON.stringify(msg));
    } catch {
      // Control channel already gone — this run has nothing left to send to.
    }
  }
}
