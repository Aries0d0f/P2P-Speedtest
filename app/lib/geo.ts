/**
 * Best-effort lookup of what this browser looks like from outside — its public
 * address and the geolocation of that address (2.6, S3). Fire-and-forget by
 * construction: `fetchSelfLookup` never throws and never blocks pairing.
 *
 * The address is carried here, alongside geo, because the endpoint answers with
 * both in one response and the ICE-derived address (`WebrtcConnection.
 * getOwnAddress`) is not always there when the initial profile is authored —
 * candidate gathering may still be in flight at channel-open. Prefetching the
 * address on the same schedule as geo means there is an answer in hand before
 * the exchange starts, instead of an `ip` that lands only sometimes.
 */

import http from "@aries0d0f/fetch-worker";

import { sanitizeGeo, type GeoInfo } from "~/model/geo.model";
import type { OwnAddress } from "~/model/connection.model";
import { isValidIp } from "~/model/peer.model";

const GEO_ENDPOINT = "https://ip.aries0d0f.me/?q=geo";

/** One answer from the endpoint: `{ ip, protocol, geo }`, split into the two
 * things this app does separately with it. Either half may be empty. */
export interface SelfLookup {
  address: OwnAddress;
  geo: GeoInfo | null;
}

const EMPTY_LOOKUP: SelfLookup = { address: {}, geo: null };

/** The endpoint answers with an envelope (`{ ip, protocol, geo }`), not a bare
 * `GeoInfo`; the flat form is still accepted so a change at either end
 * degrades rather than breaks. */
function unwrapGeoPayload(data: unknown): unknown {
  if (typeof data === "object" && data !== null) {
    const nested = (data as Record<string, unknown>).geo;
    if (typeof nested === "object" && nested !== null) return nested;
  }
  return data;
}

/** Validated with the same guard the wire uses, because this is a network
 * response like any other. `protocol` is inferred from the family when the
 * envelope omits it — the same rule the ICE path applies. */
function readAddress(data: unknown): OwnAddress {
  if (typeof data !== "object" || data === null) return {};
  const { ip, protocol } = data as { ip?: unknown; protocol?: unknown };
  if (typeof ip !== "string" || !isValidIp(ip)) return {};
  if (protocol === "IPv4" || protocol === "IPv6") return { ip, protocol };
  return { ip, protocol: ip.includes(":") ? "IPv6" : "IPv4" };
}

/** `null` means the request itself failed — distinct from a request that
 * answered with nothing usable, which is a legitimate (and cacheable) answer. */
export async function fetchSelfLookup(): Promise<SelfLookup | null> {
  return http
    .get<SelfLookup>(GEO_ENDPOINT, {
      headers: {
        Accept: "application/json",
      },
    })
    .then((res) => res.json())
    .then((data) => ({
      address: readAddress(data),
      geo: sanitizeGeo(unwrapGeoPayload(data)),
    }))
    .catch(() => null);
}

let inFlight: Promise<SelfLookup> | null = null;
let resolved: SelfLookup | null = null;

/**
 * The lookup, started once and shared by every later caller — kicked off at
 * room mount so the answer is usually in hand by the time the control channel
 * opens. The result sits in this module until `peer-profile` projects it
 * through the sender's privacy level (S3).
 *
 * A failed lookup is deliberately *not* cached, so the call at channel-open
 * time retries rather than inheriting a transient failure from mount.
 */
export function prefetchSelfLookup(): Promise<SelfLookup> {
  if (resolved !== null) return Promise.resolve(resolved);
  inFlight ??= fetchSelfLookup().then((lookup) => {
    if (lookup) resolved = lookup;
    inFlight = null;
    return lookup ?? EMPTY_LOOKUP;
  });
  return inFlight;
}

/**
 * The prefetched address if it has already landed, `{}` if it has not.
 *
 * Deliberately synchronous: the initial profile gates pairing, so it may
 * consult the prefetch but must never wait on it. Whatever is missing here is
 * sent moments later by the enrichment message, which does await.
 */
export function peekSelfAddress(): OwnAddress {
  return resolved?.address ?? {};
}

/** Test seam: drops the shared result so cases cannot leak into each other. */
export function resetSelfLookupPrefetch(): void {
  inFlight = null;
  resolved = null;
}
