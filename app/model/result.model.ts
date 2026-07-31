/**
 * The stored result record (4.3b, S6/S7). Every shape here mirrors
 * `schemas/p2p-speedtest-result.v1.schema.yaml`, which stays the single source
 * of truth — `additionalProperties: false` means a widened field set fails at
 * write time, not at compile time.
 */

import type { ConnectionType } from "./connection.model";
import type { Measurement } from "./measurement.model";
import type { PeerData } from "./peer.model";

export type ResultStatus = "SUCCEED" | "FAILED" | "CANCELED";

/** Exactly the schema's `peer` field set — never widen without updating the
 * key-set assertion in `result-validate.test.ts`. */
export type ResultPeer = Pick<PeerData, "id" | "name" | "ua" | "ip" | "protocol" | "geo">;

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
  via: ConnectionType;
}

export interface ResultMetadata {
  id: string;
  "peer-id": string;
  hash: string;
}

export const SUPPORTED_API_VERSION = "sws.aries0d0f.me/v1";

export interface P2PSpeedtestResult {
  apiVersion: "sws.aries0d0f.me/v1";
  kind: "P2PSpeedtestResult";
  metadata: ResultMetadata;
  data: ResultData;
}

export function buildMetadata(roomId: string, peerId: string, hash: string): ResultMetadata {
  return { id: roomId, "peer-id": peerId, hash };
}

/** The terminal `result-share` payload: what each peer tells the other about
 * its own half of the run before both assemble independently. */
export type ResultShare =
  | { status: "SUCCEED"; directional: Measurement; duplex: Measurement; via: ConnectionType }
  | {
      status: "FAILED" | "CANCELED";
      reason: string;
      directional?: Measurement;
      duplex?: Measurement;
      via?: ConnectionType;
    };
