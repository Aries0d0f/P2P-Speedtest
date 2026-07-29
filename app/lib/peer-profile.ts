/**
 * The self-description confirmed before a browser ever opens a room (2.5,
 * S3). Both create and join flow through the same confirm screen in
 * `home.tsx`, which is why the model lives here rather than being written
 * twice.
 */

import { UAParser } from "ua-parser-js";
import { projectGeoForAnonymous, sanitizeGeo, type GeoInfo } from "./geo";
import type { OwnAddress } from "./webrtc";
import type { Slot } from "./protocol";

export type PrivacyLevel = "off" | "on" | "anonymous";

export const PRIVACY_LEVELS: readonly PrivacyLevel[] = ["off", "on", "anonymous"];

export const DEFAULT_PRIVACY_LEVEL: PrivacyLevel = "off";

export interface ConfirmedProfile {
  name: string;
  privacyLevel: PrivacyLevel;
}

const STORAGE_KEY = "p2p-speedtest:profile";
const NAME_MAX_LENGTH = 60;
const UA_MAX_LENGTH = 300;

const NEUTRAL_NAME = "Anonymous peer";
const FALLBACK_NAME = "Unknown device";

/** Strips control characters and clamps length. Shared by the locally
 * stored profile and by anything arriving from the other, untrusted peer
 * (2.6) — the same defensive treatment either way. */
function sanitizeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (!stripped) return null;
  return stripped.slice(0, maxLength);
}

/**
 * Browser-plus-device reads as "the device a person recognises" better than
 * browser-plus-OS does on a phone or tablet, e.g. "Mobile Safari on iPhone"
 * over "Mobile Safari on iOS" — the vendor word is dropped for Apple
 * hardware specifically, since "iPhone"/"iPad" alone already reads as
 * Apple's. Gated on `device.type` (mobile, tablet, wearable, …) rather than
 * on vendor/model alone: UAParser also fills in vendor "Apple" / model
 * "Macintosh" for a plain desktop Mac, which instead collapses to the
 * shorter "Chrome on Mac" in the browser-plus-OS fallback below. A device
 * can also report a `type` without a `vendor`/`model` behind it (a generic
 * mobile UA), so all three are required together for the device-based form.
 * `withFeatureCheck()` sharpens `device`/`os` using `navigator`-level
 * signals (client hints, Brave/iPadOS detection) when `ua` is this
 * browser's own user agent; it's a no-op otherwise, so calling it
 * unconditionally is always safe. Falls back to whatever half is
 * available, then to a neutral label if UAParser yields nothing usable at
 * all.
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
    // UAParser is defensive by design, but a hostile/unusual UA string is
    // still an input this code doesn't control — fall through to the
    // neutral default rather than let a parse error block the confirm step.
  }
  return FALLBACK_NAME;
}

/**
 * The privacy level a browser is confirming for controls its *default*
 * name too (S3 design notes): announcing a UA-derived name while
 * withholding the user-agent field discloses the same information through
 * the other channel. The user can still type over it.
 */
export async function defaultNameForLevel(level: PrivacyLevel, ua: string): Promise<string> {
  return level === "off" ? await nameFromUserAgent(ua) : NEUTRAL_NAME;
}

function isPrivacyLevel(value: unknown): value is PrivacyLevel {
  return typeof value === "string" && (PRIVACY_LEVELS as string[]).includes(value);
}

/** Reads the last-used name/level so a returning user isn't re-choosing
 * every test. A stored level is never silently downgraded — whatever the
 * user last confirmed (including Anonymous) is what comes back. */
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
  const privacyLevel = isPrivacyLevel(value.privacyLevel)
    ? value.privacyLevel
    : null;
  if (!name || !privacyLevel) return null;

  return { name, privacyLevel };
}

export function saveProfile(profile: ConfirmedProfile): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // Storage unavailable (private mode, quota) — the confirm step still
    // works for this session, it just won't be remembered next time.
  }
}

/** The confirm screen's initial state: the stored profile if there is one,
 * otherwise a fresh Off-level, UA-derived default. */
export async function defaultProfile(ua: string): Promise<ConfirmedProfile> {
  return loadStoredProfile() ?? { name: await nameFromUserAgent(ua), privacyLevel: DEFAULT_PRIVACY_LEVEL };
}

// --- 2.6: own address, geo, and the peer-to-peer exchange -----------------
//
// Everything below runs over the control data channel, never the signaling
// socket (S3) — the DO has no message type for `peer-profile` and would
// drop it. What each privacy level shares/withholds is decided here, at
// the sender, before a field ever leaves this module.

/** Wire shape of `peer-profile`, sent over the control channel once it
 * opens. Every field but `name` is present only if the sender's privacy
 * level allows it; `timestamp` is slot 0's alone (S6's canonical run
 * timestamp), authored on its initial message and never resent. */
export interface PeerProfileMessage {
  name: string;
  ua?: string;
  ip?: string;
  protocol?: "IPv4" | "IPv6";
  geo?: GeoInfo | Pick<GeoInfo, "proxy" | "hosting">;
  timestamp?: string;
}

/** A `peer-profile` after sanitization — always something safe to store or
 * render, never a de-facto trust of the sender. */
export interface ReceivedPeerProfile {
  name: string;
  ua?: string;
  ip?: string;
  protocol?: "IPv4" | "IPv6";
  geo?: GeoInfo;
}

function maskIp(ip: string, protocol: "IPv4" | "IPv6"): string {
  if (protocol === "IPv4") {
    const parts = ip.split(".");
    if (parts.length !== 4) return ip; // not actually IPv4 shaped; leave alone
    return `${parts[0]}.xxx.xxx.${parts[3]}`;
  }
  const hextets = ip.split(":").filter((h) => h.length > 0);
  if (hextets.length < 2) return ip;
  return `${hextets[0]}::xxxx:${hextets[hextets.length - 1]}`;
}

/** `name`/`ip`/`protocol`/`ua` per the privacy table (S3). `ip` is already
 * masked by the sender when the level requires it — the receiver never has
 * to know which level produced what it got. */
function addressFields(
  profile: ConfirmedProfile,
  ua: string,
  address: OwnAddress,
): Pick<PeerProfileMessage, "ua" | "ip" | "protocol"> {
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

function geoField(
  profile: ConfirmedProfile,
  geo: GeoInfo | null,
): PeerProfileMessage["geo"] {
  return profile.privacyLevel === "anonymous" ? projectGeoForAnonymous(geo) : geo ?? undefined;
}

/** The initial `peer-profile`: sent as soon as the control channel opens,
 * without waiting on geo (2.6). Must contain a valid `name`; slot 0's must
 * also carry the canonical run timestamp, captured here rather than at
 * result time so two independently authored timestamps can never occur. */
export function buildInitialProfileMessage(
  profile: ConfirmedProfile,
  ua: string,
  address: OwnAddress,
  slot: Slot,
): PeerProfileMessage {
  return {
    name: profile.name,
    ...addressFields(profile, ua, address),
    ...(slot === 0 ? { timestamp: new Date().toISOString() } : {}),
  };
}

/** A later `peer-profile` that enriches the stored profile with geo and any
 * address fields that became available after the initial message. Resends
 * `name`/`ua`/`ip` too, so this message is a complete, standalone
 * description rather than a diff the receiver must merge field-by-field. */
export function buildEnrichmentProfileMessage(
  profile: ConfirmedProfile,
  ua: string,
  address: OwnAddress,
  geo: GeoInfo | null,
): PeerProfileMessage {
  const geoValue = geoField(profile, geo);
  return {
    name: profile.name,
    ...addressFields(profile, ua, address),
    ...(geoValue ? { geo: geoValue } : {}),
  };
}

const IPV4_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const IPV4_MASKED_PATTERN = /^[0-9]{1,3}\.xxx\.xxx\.[0-9]{1,3}$/;
const IPV6_MASKED_PATTERN = /^[0-9a-f]{1,4}::xxxx:[0-9a-f]{1,4}$/i;

function isValidIp(value: string): boolean {
  if (IPV4_PATTERN.test(value)) {
    return value.split(".").every((octet) => Number(octet) <= 255);
  }
  if (IPV4_MASKED_PATTERN.test(value)) return true;
  if (IPV6_MASKED_PATTERN.test(value)) return true;
  // Full IPv6 is intentionally validated loosely: this only guards what
  // gets stored and displayed, not routing, and the real grammar is large.
  return value.includes(":") && /^[0-9a-f:]+$/i.test(value);
}

/**
 * Sanitises a `peer-profile` payload from the other, untrusted peer (2.6):
 * clamps `name`/`ua` length and strips control characters, drops an `ip`
 * that is neither a valid address nor a valid masked form, drops an
 * unrecognised `protocol`, and drops unknown/wrong-typed `geo` keys via the
 * same validator used for the first-party geo lookup. Returns `null` only
 * when `name` — the one schema-required field — doesn't survive: a
 * profile assembler falls back to a slot-based label in that case rather
 * than storing an unnamed peer.
 */
export function sanitizeIncomingProfile(raw: unknown): ReceivedPeerProfile | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;

  const name = sanitizeText(value.name, NAME_MAX_LENGTH);
  if (!name) return null;

  const result: ReceivedPeerProfile = { name };

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

export interface ValidatedInitialProfile extends ReceivedPeerProfile {
  /** Present and a valid ISO timestamp only for a message `fromSlot === 0`
   * (S6's canonical run timestamp); absent for slot 1. */
  timestamp?: string;
}

/**
 * Validates an initial `peer-profile` against the testing-barrier
 * requirement (2.6): a usable `name`, and — only when it came from slot 0
 * — a valid `timestamp`. `channel-ready` (Phase 3) may not fire until this
 * returns non-null for the remote peer's initial message.
 */
export function validateInitialProfile(
  raw: unknown,
  fromSlot: Slot,
): ValidatedInitialProfile | null {
  const sanitized = sanitizeIncomingProfile(raw);
  if (!sanitized) return null;
  if (fromSlot !== 0) return sanitized;

  const value = raw as Record<string, unknown>;
  if (typeof value.timestamp !== "string" || Number.isNaN(Date.parse(value.timestamp))) {
    return null;
  }
  return { ...sanitized, timestamp: value.timestamp };
}

/** Slot-based fallback label (S6) for a peer whose profile never arrived —
 * `name` is schema-required and no server supplies a default, so the
 * receiving peer provides one rather than producing an unstorable record. */
export function fallbackPeerName(slot: Slot): string {
  return slot === 0 ? "Peer A" : "Peer B";
}

// --- Wire framing over the control channel ---------------------------------
//
// `peer-profile` never touches the signaling socket (the DO has no message
// type for it and would drop it), but it uses the same `{ type, runId,
// payload }` shape as a signaling envelope so both transports read the
// same way in a wire capture.

export interface ProfileEnvelope {
  type: "peer-profile";
  runId: string;
  payload: PeerProfileMessage;
}

export function encodeProfileEnvelope(runId: string, payload: PeerProfileMessage): string {
  return JSON.stringify({ type: "peer-profile", runId, payload } satisfies ProfileEnvelope);
}

/** Parses and run-scopes a control-channel message. Returns `null` for
 * anything malformed, for a different run's stale message, or for a
 * message type this exchange doesn't define — the caller never has to
 * trust the shape of what an untrusted peer sent. */
export function decodeProfileEnvelope(data: unknown, runId: string): unknown | null {
  if (typeof data !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const value = parsed as Record<string, unknown>;
  if (value.type !== "peer-profile" || value.runId !== runId) return null;
  return value.payload;
}
