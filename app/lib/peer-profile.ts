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
  sanitizeDevice,
  sanitizeText,
  type ConfirmedProfile,
  type DeviceBrand,
  type DeviceInfo,
  type DeviceType,
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

/**
 * UAParser reports the distribution, not "Linux", for most desktop Linux — so
 * the badge is the distribution wherever this app has its mark. Keys are
 * UAParser's own `OSName` spellings; anything Linux-shaped that is missing
 * here still gets the generic penguin below, and anything unrecognized
 * entirely gets no badge, because a wrong logo is worse than none.
 */
const LINUX_BRANDS: Readonly<Record<string, DeviceBrand>> = {
  Arch: "arch",
  CentOS: "centos",
  Debian: "debian",
  Deepin: "deepin",
  "elementary OS": "elementary",
  Fedora: "fedora",
  Gentoo: "gentoo",
  GNU: "gnu",
  Kubuntu: "kubuntu",
  Manjaro: "manjaro",
  Mint: "mint",
  Raspbian: "raspbian",
  RedHat: "redhat",
  Slackware: "slackware",
  SUSE: "suse",
  Ubuntu: "ubuntu",
  "Ubuntu Touch": "ubuntu",
  Xubuntu: "xubuntu",
  // Distributions with no mark of their own, kept here so they are still
  // recognized as Linux rather than falling through to no badge at all.
  Joli: "linux",
  Knoppix: "linux",
  Linpus: "linux",
  Linspire: "linux",
  Linux: "linux",
  Mageia: "linux",
  Mandriva: "linux",
  PCLinuxOS: "linux",
  Sabayon: "linux",
  VectorLinux: "linux",
  Zenwalk: "linux",
};

function brandFor(osName: string | undefined, vendor: string | undefined): DeviceBrand | undefined {
  if (vendor === "Apple" || osName === "macOS" || osName === "iOS" || osName === "watchOS") {
    return "apple";
  }
  if (vendor === "Microsoft" || osName?.startsWith("Windows")) return "microsoft";
  if (vendor === "Google" || osName?.startsWith("Android") || osName === "Chrome OS") {
    return "google";
  }
  return osName ? LINUX_BRANDS[osName] : undefined;
}

/** UAParser has no `desktop` type — it leaves `type` unset for one — so an
 * absent type is read as a desktop, but only once the UA has identified a
 * platform at all: on a blank or unparsable one the same absence means
 * nothing was learned. Console, TV, wearable and XR get no form factor rather
 * than being forced into one of the three this app draws. */
function typeFor(uaType: string | undefined, osName: string | undefined): DeviceType | undefined {
  if (uaType === undefined) return osName ? "desktop" : undefined;
  if (uaType === "mobile") return "mobile";
  if (uaType === "tablet") return "tablet";
  return undefined;
}

function toDeviceInfo(
  osName: string | undefined,
  uaType: string | undefined,
  vendor: string | undefined,
): DeviceInfo | null {
  const info: DeviceInfo = {};
  const type = typeFor(uaType, osName);
  const brand = brandFor(osName, vendor);
  if (type) info.type = type;
  if (brand) info.brand = brand;
  return info.type || info.brand ? info : null;
}

/**
 * This browser describing its own hardware, for the peer to draw. Async and
 * feature-checked for the same reason `nameFromUserAgent` is: a reduced UA
 * string no longer distinguishes an iPad from a Mac, and only the device
 * itself can settle it (`withFeatureCheck()` reads client hints and touch
 * support, and is a no-op on any UA but this browser's own).
 */
export async function describeDevice(ua: string): Promise<DeviceInfo | null> {
  try {
    const { os, device } = await new UAParser(ua).getResult().withFeatureCheck();
    return toDeviceInfo(os.name, device.type, device.vendor);
  } catch {
    return null;
  }
}

/**
 * The receiver's fallback: what can be read off a peer's raw UA string when
 * it did not send a `device` of its own — an older peer, or a stored result,
 * which keeps `ua` but not the descriptor.
 *
 * `null` in, `null` out: a peer whose privacy level withheld its UA has told
 * us nothing about its hardware, and UAParser with no argument would answer
 * with *this* browser's — showing the reader their own device as the peer's.
 *
 * `name` is consulted only for the case a UA string cannot express: a tablet
 * browser that identifies as a desktop one (iPadOS Safari says Macintosh),
 * where the sender's own feature-checked name still says "iPad" or "Tab".
 */
export function guessDevice(ua: string | undefined, name?: string): DeviceInfo | null {
  if (!ua) return null;
  try {
    const { os, device } = new UAParser(ua).getResult();
    const info = toDeviceInfo(os.name, device.type, device.vendor);
    if (info && info.type === "desktop" && name && /tab|pad/i.test(name)) {
      return { ...info, type: "tablet" };
    }
    return info;
  } catch {
    return null;
  }
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

/** `ua`/`device`/`ip`/`protocol` per the privacy table (S3). `ip` is already
 * masked by the sender when the level requires it — the receiver never has to
 * know which level produced what it got. `device` is disclosed with `ua` and
 * only with it: it says no more than the UA already does, but says it in the
 * one place that can still answer accurately. */
async function addressFields(
  profile: ConfirmedProfile,
  ua: string,
  address: OwnAddress,
): Promise<Pick<PeerProfile, "ua" | "device" | "ip" | "protocol">> {
  const hasAddress = address.ip !== undefined && address.protocol !== undefined;

  if (profile.privacyLevel === "off") {
    const device = await describeDevice(ua);
    return {
      ua,
      ...(device ? { device } : {}),
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
export async function buildInitialProfileMessage(
  profile: ConfirmedProfile,
  ua: string,
  address: OwnAddress,
  slot: Slot,
): Promise<PeerProfile> {
  const fields = await addressFields(profile, ua, address);
  return {
    name: profile.name,
    ...fields,
    // Stamped after the await, so the run's canonical timestamp is the moment
    // the message is actually authored.
    ...(slot === 0 ? { timestamp: new Date().toISOString() } : {}),
  };
}

/** Enriches the stored profile with geo and any address fields that became
 * available after the initial message. Resends `name`/`ua`/`ip` too, so this
 * is a complete, standalone description rather than a diff the receiver must
 * merge field-by-field. */
export async function buildEnrichmentProfileMessage(
  profile: ConfirmedProfile,
  ua: string,
  address: OwnAddress,
  geo: GeoInfo | null,
): Promise<PeerProfile> {
  const geoValue = geoField(profile, geo);
  const fields = await addressFields(profile, ua, address);
  return {
    name: profile.name,
    ...fields,
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

  const device = sanitizeDevice(value.device);
  if (device) result.device = device;

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
