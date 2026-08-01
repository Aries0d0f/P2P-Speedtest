/**
 * The one description of a peer. Every other shape of it — the confirmed
 * self-profile, the wire `peer-profile`, the stored result's peer — is a
 * projection of `PeerData`, so a field can only ever be described once.
 */

import type { GeoInfo } from "./geo.model";
import type { Slot } from "./signaling.model";

export type PrivacyLevel = "off" | "on" | "anonymous";
export type IpProtocol = "IPv4" | "IPv6";

export const DEVICE_TYPES = ["mobile", "tablet", "desktop"] as const;

/**
 * The platform badges this app can draw, and so the only values `brand` may
 * take. Distributions are listed individually because a Linux user's
 * distribution is the badge they recognize; `linux` is the generic mark for
 * the rest.
 */
export const DEVICE_BRANDS = [
  "apple",
  "microsoft",
  "google",
  "linux",
  "arch",
  "centos",
  "debian",
  "deepin",
  "elementary",
  "fedora",
  "gentoo",
  "gnu",
  "kubuntu",
  "manjaro",
  "mint",
  "raspbian",
  "redhat",
  "slackware",
  "suse",
  "ubuntu",
  "xubuntu",
] as const;

export type DeviceType = (typeof DEVICE_TYPES)[number];
export type DeviceBrand = (typeof DEVICE_BRANDS)[number];

/**
 * Exactly what the other side needs to draw this peer's icon — a form factor
 * and a platform badge, nothing finer. A sender knows its own hardware better
 * than any receiver can (client hints answer what a reduced UA string no
 * longer says), so at privacy Off it tells the peer rather than making it
 * guess. Neither field is a model name or an OS version: those live in `ua`,
 * which the privacy table governs separately.
 */
export interface DeviceInfo {
  /** Absent when the platform reported no form factor at all. */
  type?: DeviceType;
  /** Absent when the platform is not one this app has a badge for. */
  brand?: DeviceBrand;
}

export interface PeerData {
  id: string;
  slot: Slot;
  name: string;
  /** Never leaves the browser: it is *applied* at send time by the profile
   * builders, and no projection below carries it. */
  privacyLevel: PrivacyLevel;
  ua?: string;
  /** Travels with `ua` — same privacy level, same disclosure. */
  device?: DeviceInfo;
  ip?: string;
  protocol?: IpProtocol;
  geo?: GeoInfo;
  /** Slot 0's alone (S6's canonical run timestamp), authored on its initial
   * `peer-profile` and never resent. */
  timestamp?: string;
}

/** What the confirm screen produces and stores locally. */
export type ConfirmedProfile = Pick<PeerData, "name" | "privacyLevel">;

/** Who a peer is on the signaling layer. */
export type PeerIdentity = Pick<PeerData, "id" | "slot">;

/** The `peer-profile` wire payload, and equally its sanitized form — the two
 * were always the same field set. */
export type PeerProfile = Omit<PeerData, "id" | "slot" | "privacyLevel">;

/** An initial `peer-profile` from slot 0, whose timestamp is required. */
export type InitialProfile = PeerProfile & Required<Pick<PeerProfile, "timestamp">>;

/** A peer as the assembler and the terminal controller see it: identity plus
 * whatever profile arrived. `profile` is `null` when none ever did, and the
 * assembler then falls back to a slot-based name rather than producing an
 * unstorable record. */
export type PeerWithProfile = PeerIdentity & { profile: PeerProfile | null };

export const PRIVACY_LEVELS: readonly PrivacyLevel[] = ["off", "on", "anonymous"];
export const DEFAULT_PRIVACY_LEVEL: PrivacyLevel = "off";

export const NAME_MAX_LENGTH = 60;
export const UA_MAX_LENGTH = 300;

export function isPrivacyLevel(value: unknown): value is PrivacyLevel {
  return typeof value === "string" && (PRIVACY_LEVELS as string[]).includes(value);
}

/** Strips control characters and clamps length. Applied to the locally stored
 * profile and to anything arriving from the other, untrusted peer alike. */
export function sanitizeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (!stripped) return null;
  return stripped.slice(0, maxLength);
}

/**
 * Both fields are closed enumerations, so an untrusted peer can only ever
 * select one of this app's own icons — never inject a string the view would
 * render. Returns `null` when nothing recognizable survives, which keeps an
 * empty `{}` off the wire and out of the merged profile.
 */
export function sanitizeDevice(value: unknown): DeviceInfo | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;

  const result: DeviceInfo = {};
  if (typeof raw.type === "string" && (DEVICE_TYPES as readonly string[]).includes(raw.type)) {
    result.type = raw.type as DeviceType;
  }
  if (typeof raw.brand === "string" && (DEVICE_BRANDS as readonly string[]).includes(raw.brand)) {
    result.brand = raw.brand as DeviceBrand;
  }
  return result.type || result.brand ? result : null;
}

export function maskIp(ip: string, protocol: IpProtocol): string {
  if (protocol === "IPv4") {
    const parts = ip.split(".");
    if (parts.length !== 4) return ip; // not actually IPv4 shaped; leave alone
    return `${parts[0]}.xxx.xxx.${parts[3]}`;
  }
  const hextets = ip.split(":").filter((h) => h.length > 0);
  if (hextets.length < 2) return ip;
  return `${hextets[0]}::xxxx:${hextets[hextets.length - 1]}`;
}

const IPV4_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const IPV4_MASKED_PATTERN = /^[0-9]{1,3}\.xxx\.xxx\.[0-9]{1,3}$/;
const IPV6_MASKED_PATTERN = /^[0-9a-f]{1,4}::xxxx:[0-9a-f]{1,4}$/i;

export function isValidIp(value: string): boolean {
  if (IPV4_PATTERN.test(value)) {
    return value.split(".").every((octet) => Number(octet) <= 255);
  }
  if (IPV4_MASKED_PATTERN.test(value)) return true;
  if (IPV6_MASKED_PATTERN.test(value)) return true;
  // Full IPv6 is intentionally validated loosely: this only guards what gets
  // stored and displayed, not routing, and the real grammar is large.
  return value.includes(":") && /^[0-9a-f:]+$/i.test(value);
}

/** Slot-based fallback label (S6) for a peer whose profile never arrived —
 * `name` is schema-required and no server supplies a default. */
export function fallbackPeerName(slot: Slot): string {
  return slot === 0 ? "Peer A" : "Peer B";
}
