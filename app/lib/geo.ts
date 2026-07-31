/**
 * Best-effort geolocation for this browser's own address (2.6, S3). Fire-and-
 * forget by construction: `fetchGeo` never throws and never blocks pairing.
 */

import { sanitizeGeo, type GeoInfo } from "~/model/geo.model";

const GEO_ENDPOINT = "https://ip.aries0d0f.me/?q=geo";

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

export async function fetchGeo(): Promise<GeoInfo | null> {
  try {
    const resp = await fetch(GEO_ENDPOINT, {
      headers: {
        'Accept': 'application/json'
      }
    });
    if (!resp.ok) return null;
    return sanitizeGeo(unwrapGeoPayload(await resp.json()));
  } catch {
    return null;
  }
}

let inFlight: Promise<GeoInfo | null> | null = null;
let resolved: GeoInfo | null = null;

/**
 * The lookup, started once and shared by every later caller — kicked off at
 * room mount so the answer is usually in hand by the time the control channel
 * opens. The result sits in this module until `peer-profile` projects it
 * through the sender's privacy level (S3).
 *
 * A failed lookup is deliberately *not* cached, so the call at channel-open
 * time retries rather than inheriting a transient failure from mount.
 */
export function prefetchGeo(): Promise<GeoInfo | null> {
  if (resolved !== null) return Promise.resolve(resolved);
  inFlight ??= fetchGeo().then((geo) => {
    resolved = geo;
    inFlight = null;
    return geo;
  });
  return inFlight;
}

/** Test seam: drops the shared result so cases cannot leak into each other. */
export function resetGeoPrefetch(): void {
  inFlight = null;
  resolved = null;
}
