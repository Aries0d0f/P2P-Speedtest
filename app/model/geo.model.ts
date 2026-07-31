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

/** A validated pair of coordinates a peer actually chose to share. */
export type GeoPoint = Required<Pick<GeoInfo, "lat" | "lon">>;

/** All an Anonymous-level sender may disclose. */
export type AnonymousGeo = Pick<GeoInfo, "proxy" | "hosting">;

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

/** Keeps only fields the schema defines, of the type it expects. Applied both
 * to the geo-lookup response and to a `geo` object arriving from the other,
 * untrusted peer over the data channel (2.6). */
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

/** Anonymous-level projection (S3), applied at parse time rather than send
 * time: an unfiltered `GeoInfo` that merely happens not to be sent yet is one
 * refactor away from being sent. */
export function projectGeoForAnonymous(geo: GeoInfo | null): AnonymousGeo | undefined {
  if (!geo) return undefined;
  const result: AnonymousGeo = {};
  if (typeof geo.proxy === "boolean") result.proxy = geo.proxy;
  if (typeof geo.hosting === "boolean") result.hosting = geo.hosting;
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Coordinates are usable only if finite and in range. An out-of-range value
 * means "unavailable"; it is never clamped into a plausible-looking but false
 * location. */
export function toGeoPoint(geo: Pick<GeoInfo, "lat" | "lon"> | undefined | null): GeoPoint | null {
  if (!geo) return null;
  const { lat, lon } = geo;
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}
