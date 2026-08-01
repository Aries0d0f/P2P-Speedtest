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

/** Both fields or neither: a half-known address is no address, and `ip`
 * without its family would be published as an unlabelled string. */
export function isCompleteAddress(address: OwnAddress): boolean {
  return address.ip !== undefined && address.protocol !== undefined;
}

/**
 * ICE first, the prefetched lookup second.
 *
 * The ICE-derived address is preferred because it describes the path the
 * connection actually took (2.6) — but it is only there once candidate
 * gathering has produced a usable candidate, which at channel-open time it
 * sometimes has not. The lookup's address is the same browser's public
 * address seen from the geo endpoint, so falling back to it fills that gap
 * rather than inventing anything.
 *
 * Never mixed field-by-field: the two sources can disagree on family (STUN
 * over IPv4 while HTTP went IPv6), and one source's `ip` beside the other's
 * `protocol` would be a false pair.
 */
export function resolveOwnAddress(ice: OwnAddress, fallback: OwnAddress): OwnAddress {
  if (isCompleteAddress(ice)) return ice;
  return isCompleteAddress(fallback) ? fallback : ice;
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
