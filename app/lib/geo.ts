/**
 * Best-effort geolocation for this browser's own address (2.6, S3). Fire-
 * and-forget by construction: `fetchGeo` never throws and never blocks
 * pairing, and its result is enrichment sent over the control channel once
 * the peer-profile module has it, never a gate on the testing barrier.
 */

export interface GeoInfo {
  continent?: string;
  continentCode?: string;
  country?: string;
  countryCode?: string;
  region?: string;
  regionName?: string;
  city?: string;
  district?: string;
  zip?: string;
  lat?: number;
  lon?: number;
  timezone?: string;
  offset?: number;
  isp?: string;
  org?: string;
  as?: string;
  asname?: string;
  mobile?: boolean;
  proxy?: boolean;
  hosting?: boolean;
}

const GEO_ENDPOINT = "https://ip.aries0d0f.me/?q=geo";

const STRING_FIELDS = [
  "continent",
  "continentCode",
  "country",
  "countryCode",
  "region",
  "regionName",
  "city",
  "district",
  "zip",
  "timezone",
  "isp",
  "org",
  "as",
  "asname",
] as const satisfies readonly (keyof GeoInfo)[];

const BOOLEAN_FIELDS = ["mobile", "proxy", "hosting"] as const satisfies readonly (keyof GeoInfo)[];

/**
 * Keeps only fields the schema defines, of the type it expects. Used both
 * for the geo-lookup response (a well-known first-party endpoint, but its
 * response shape is still an external input) and for a `geo` object
 * arriving from the other, untrusted peer over the data channel (2.6).
 */
export function sanitizeGeo(data: unknown): GeoInfo | null {
  if (typeof data !== "object" || data === null) return null;
  const value = data as Record<string, unknown>;
  const result: GeoInfo = {};

  for (const field of STRING_FIELDS) {
    if (typeof value[field] === "string") result[field] = value[field] as string;
  }
  for (const field of BOOLEAN_FIELDS) {
    if (typeof value[field] === "boolean") result[field] = value[field] as boolean;
  }
  if (typeof value.lat === "number" && value.lat >= -90 && value.lat <= 90) {
    result.lat = value.lat;
  }
  if (typeof value.lon === "number" && value.lon >= -180 && value.lon <= 180) {
    result.lon = value.lon;
  }
  if (typeof value.offset === "number" && Number.isInteger(value.offset)) {
    result.offset = value.offset;
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * The endpoint answers with an envelope, not a bare `GeoInfo`:
 *
 *     { "ip": "…", "protocol": "IPv4", "geo": { "lat": …, "lon": …, … } }
 *
 * `sanitizeGeo` reads its fields from the top level, so handing it the
 * envelope silently produced `null` for every lookup — every peer looked as
 * though it had withheld its location whatever its privacy level. The flat
 * form is still accepted so a change at either end degrades rather than
 * breaks.
 */
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

/**
 * Anonymous-level projection (S3), applied at the point of parsing rather
 * than the point of sending: an unfiltered `GeoInfo` that merely happens
 * not to be sent yet is one refactor away from being sent. Everything
 * except `proxy`/`hosting` is dropped here, before the caller ever has a
 * chance to serialize the rest.
 */
export function projectGeoForAnonymous(
  geo: GeoInfo | null,
): Pick<GeoInfo, "proxy" | "hosting"> | undefined {
  if (!geo) return undefined;
  const result: Pick<GeoInfo, "proxy" | "hosting"> = {};
  if (typeof geo.proxy === "boolean") result.proxy = geo.proxy;
  if (typeof geo.hosting === "boolean") result.hosting = geo.hosting;
  return Object.keys(result).length > 0 ? result : undefined;
}
