/**
 * Building and sanitizing a peer's self-description (2.5, 2.6, S3).
 *
 * Everything below the storage helpers runs over the control data channel,
 * never the signaling socket — the DO has no `peer-profile` type and would
 * drop it. What each privacy level shares or withholds is decided here, at the
 * sender, before a field ever leaves this module.
 */

import { UAParser } from "ua-parser-js";
import { projectGeoForAnonymous, sanitizeGeo, type GeoInfo } from "~/model/geo.model";
import type { OwnAddress } from "~/model/connection.model";
import type { Slot } from "~/model/signaling.model";
import {
  DEFAULT_PRIVACY_LEVEL,
  NAME_MAX_LENGTH,
  UA_MAX_LENGTH,
  isPrivacyLevel,
  isValidIp,
  maskIp,
  sanitizeText,
  type ConfirmedProfile,
  type InitialProfile,
  type PeerProfile,
  type PrivacyLevel,
} from "~/model/peer.model";

const STORAGE_KEY = "p2p-speedtest:profile";

const NEUTRAL_NAME = "Anonymous peer";
const FALLBACK_NAME = "Unknown device";

/**
 * Gated on `device.type` rather than vendor/model alone: UAParser fills in
 * vendor "Apple" / model "Macintosh" for a plain desktop Mac, which should
 * collapse to "Chrome on Mac" rather than name the model.
 * `withFeatureCheck()` is a no-op unless `ua` is this browser's own, so
 * calling it unconditionally is safe.
 */
export async function nameFromUserAgent(ua: string): Promise<string> {
  try {
    const { browser, os, device } = await new UAParser(ua).getResult().withFeatureCheck();
    if (browser.name && device.type && device.vendor && device.model) {
      if (device.vendor === "Apple") return `${browser.name} on ${device.model}`;
      return `${browser.name} on ${device.vendor} ${device.model}`;
    }
    if (browser.name && os.name) {
      if (os.name === "macOS" || device.vendor === "Apple") return `${browser.name} on Mac`;
      return `${browser.name} on ${os.name}`;
    }
    if (browser.name) return browser.name;
    if (os.name) return `Device on ${os.name}`;
  } catch {
    // A hostile/unusual UA string is an input this code doesn't control —
    // fall through rather than let a parse error block the confirm step.
  }
  return FALLBACK_NAME;
}

/** The privacy level controls the *default* name too (S3): announcing a
 * UA-derived name while withholding the user-agent field discloses the same
 * information through the other channel. The user can still type over it. */
export async function defaultNameForLevel(level: PrivacyLevel, ua: string): Promise<string> {
  return level === "off" ? await nameFromUserAgent(ua) : NEUTRAL_NAME;
}

/** A stored level is never silently downgraded — whatever the user last
 * confirmed (including Anonymous) is what comes back. */
export function loadStoredProfile(): ConfirmedProfile | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return null; // storage disabled/unavailable — treat as first use
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const value = parsed as Record<string, unknown>;

  const name = sanitizeText(value.name, NAME_MAX_LENGTH);
  const privacyLevel = isPrivacyLevel(value.privacyLevel) ? value.privacyLevel : null;
  if (!name || !privacyLevel) return null;

  return { name, privacyLevel };
}

export function saveProfile(profile: ConfirmedProfile): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // Storage unavailable (private mode, quota) — this session still works,
    // it just won't be remembered next time.
  }
}

/** The confirm screen's initial state. */
export async function defaultProfile(ua: string): Promise<ConfirmedProfile> {
  return (
    loadStoredProfile() ?? {
      name: await nameFromUserAgent(ua),
      privacyLevel: DEFAULT_PRIVACY_LEVEL,
    }
  );
}

/** `ua`/`ip`/`protocol` per the privacy table (S3). `ip` is already masked by
 * the sender when the level requires it — the receiver never has to know
 * which level produced what it got. */
function addressFields(
  profile: ConfirmedProfile,
  ua: string,
  address: OwnAddress,
): Pick<PeerProfile, "ua" | "ip" | "protocol"> {
  const hasAddress = address.ip !== undefined && address.protocol !== undefined;

  if (profile.privacyLevel === "off") {
    return {
      ua,
      ...(hasAddress ? { ip: address.ip, protocol: address.protocol } : {}),
    };
  }
  if (profile.privacyLevel === "on") {
    return hasAddress ? { ip: address.ip, protocol: address.protocol } : {};
  }
  // anonymous
  return hasAddress
    ? { ip: maskIp(address.ip!, address.protocol!), protocol: address.protocol }
    : {};
}

function geoField(profile: ConfirmedProfile, geo: GeoInfo | null): PeerProfile["geo"] {
  return profile.privacyLevel === "anonymous" ? projectGeoForAnonymous(geo) : geo ?? undefined;
}

/** Sent as soon as the control channel opens, without waiting on geo (2.6).
 * Slot 0's also carries the canonical run timestamp, captured here rather than
 * at result time so two independently authored timestamps can never occur. */
export function buildInitialProfileMessage(
  profile: ConfirmedProfile,
  ua: string,
  address: OwnAddress,
  slot: Slot,
): PeerProfile {
  return {
    name: profile.name,
    ...addressFields(profile, ua, address),
    ...(slot === 0 ? { timestamp: new Date().toISOString() } : {}),
  };
}

/** Enriches the stored profile with geo and any address fields that became
 * available after the initial message. Resends `name`/`ua`/`ip` too, so this
 * is a complete, standalone description rather than a diff the receiver must
 * merge field-by-field. */
export function buildEnrichmentProfileMessage(
  profile: ConfirmedProfile,
  ua: string,
  address: OwnAddress,
  geo: GeoInfo | null,
): PeerProfile {
  const geoValue = geoField(profile, geo);
  return {
    name: profile.name,
    ...addressFields(profile, ua, address),
    ...(geoValue ? { geo: geoValue } : {}),
  };
}

/** Returns `null` only when `name` — the one schema-required field — doesn't
 * survive; an assembler then falls back to a slot-based label rather than
 * storing an unnamed peer. */
export function sanitizeIncomingProfile(raw: unknown): PeerProfile | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;

  const name = sanitizeText(value.name, NAME_MAX_LENGTH);
  if (!name) return null;

  const result: PeerProfile = { name };

  const ua = sanitizeText(value.ua, UA_MAX_LENGTH);
  if (ua) result.ua = ua;

  if (typeof value.ip === "string" && isValidIp(value.ip)) {
    result.ip = value.ip;
  }
  if (value.protocol === "IPv4" || value.protocol === "IPv6") {
    result.protocol = value.protocol;
  }

  const geo = sanitizeGeo(value.geo);
  if (geo) result.geo = geo;

  return result;
}

/** `channel-ready` may not fire until this returns non-null for the remote
 * peer's initial message. Slot 0's must also carry a valid `timestamp`. */
export function validateInitialProfile(
  raw: unknown,
  fromSlot: Slot,
): PeerProfile | InitialProfile | null {
  const sanitized = sanitizeIncomingProfile(raw);
  if (!sanitized) return null;
  if (fromSlot !== 0) return sanitized;

  const value = raw as Record<string, unknown>;
  if (typeof value.timestamp !== "string" || Number.isNaN(Date.parse(value.timestamp))) {
    return null;
  }
  return { ...sanitized, timestamp: value.timestamp };
}
