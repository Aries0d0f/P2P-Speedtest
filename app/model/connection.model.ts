/** How the two peers are actually connected, and how their several parallel
 * `RTCPeerConnection`s are numbered. */

export type ConnectionType = "DIRECT" | "RELAY" | "UNKNOWN";

export function isConnectionType(value: unknown): value is ConnectionType {
  return value === "DIRECT" || value === "RELAY" || value === "UNKNOWN";
}

/** Which single channel a connection carries: reliable/ordered `control`, or
 * unordered/non-retransmitting `bulk`. */
export type ChannelLabel = "control" | "bulk";

/** This peer's own address, derived from its gathered ICE candidates rather
 * than asked of anyone (2.6). Both fields are absent when neither a
 * server-reflexive nor a host candidate was usable. */
export interface OwnAddress {
  ip?: string;
  protocol?: "IPv4" | "IPv6";
}

/** How many parallel bulk `RTCPeerConnection`s run alongside the one control
 * connection — genuinely parallel, each with its own congestion window. */
export const BULK_CONNECTION_COUNT = 4;

/** `connIndex` values: 0 is always the control connection; bulk connections
 * take 1..`BULK_CONNECTION_COUNT`. */
export const CONTROL_CONN_INDEX = 0;

export function bulkConnIndex(bulkSlot: number): number {
  return CONTROL_CONN_INDEX + 1 + bulkSlot;
}
