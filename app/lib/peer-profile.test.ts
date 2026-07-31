import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildEnrichmentProfileMessage,
  buildInitialProfileMessage,
  defaultNameForLevel,
  defaultProfile,
  loadStoredProfile,
  nameFromUserAgent,
  sanitizeIncomingProfile,
  saveProfile,
  validateInitialProfile,
} from "./peer-profile";
import { fallbackPeerName, type ConfirmedProfile } from "~/model/peer.model";
import type { OwnAddress } from "~/model/connection.model";

const CHROME_MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const GENERIC_MOBILE_UA = "Mozilla/5.0 (Mobile; rv:120.0) Gecko/120.0 Firefox/120.0";

// This vitest pool runs on workerd, which has no `localStorage` — stub an
// in-memory implementation so the persistence round-trip is testable.
function stubLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("nameFromUserAgent", () => {
  it("combines browser and OS, collapsing macOS to the shorter 'Mac'", async () => {
    expect(await nameFromUserAgent(CHROME_MAC_UA)).toBe("Chrome on Mac");
  });

  it("prefers browser-plus-device for a phone, dropping the vendor word for Apple hardware", async () => {
    expect(await nameFromUserAgent(IPHONE_UA)).toBe("Mobile Safari on iPhone");
  });

  it("falls back to browser-plus-OS when device type is known but vendor/model aren't", async () => {
    // A generic mobile UA reports device.type without vendor/model — must
    // not interpolate "undefined undefined" into the name.
    expect(await nameFromUserAgent(GENERIC_MOBILE_UA)).toBe("Mobile Firefox on Firefox OS");
  });

  it("falls back to a neutral label for an unparsable UA", async () => {
    expect(await nameFromUserAgent("")).toBe("Unknown device");
  });
});

describe("defaultNameForLevel", () => {
  it("uses the UA-derived name at Off", async () => {
    expect(await defaultNameForLevel("off", CHROME_MAC_UA)).toBe("Chrome on Mac");
  });

  it("uses a neutral name at On and Anonymous, never leaking the UA", async () => {
    expect(await defaultNameForLevel("on", CHROME_MAC_UA)).toBe("Anonymous peer");
    expect(await defaultNameForLevel("anonymous", CHROME_MAC_UA)).toBe("Anonymous peer");
  });
});

describe("stored profile persistence", () => {
  beforeEach(() => stubLocalStorage());

  it("round-trips a saved profile", () => {
    const profile: ConfirmedProfile = { name: "Alice", privacyLevel: "anonymous" };
    saveProfile(profile);
    expect(loadStoredProfile()).toEqual(profile);
  });

  it("never silently downgrades a stored Anonymous level on reload", async () => {
    saveProfile({ name: "Alice", privacyLevel: "anonymous" });
    const reloaded = await defaultProfile(CHROME_MAC_UA);
    expect(reloaded.privacyLevel).toBe("anonymous");
    expect(reloaded.name).toBe("Alice");
  });

  it("defaults to Off with a UA-derived name on first use", async () => {
    expect(await defaultProfile(CHROME_MAC_UA)).toEqual({
      name: "Chrome on Mac",
      privacyLevel: "off",
    });
  });

  it("rejects a corrupted stored value rather than throwing", () => {
    localStorage.setItem("p2p-speedtest:profile", "not json");
    expect(loadStoredProfile()).toBeNull();
  });
});

describe("stored profile persistence without localStorage", () => {
  it("loadStoredProfile and saveProfile degrade gracefully", () => {
    expect(loadStoredProfile()).toBeNull();
    expect(() => saveProfile({ name: "x", privacyLevel: "off" })).not.toThrow();
  });
});

const ADDRESS_V4: OwnAddress = { ip: "203.0.113.7", protocol: "IPv4" };
const NO_ADDRESS: OwnAddress = {};

describe("buildInitialProfileMessage", () => {
  it("Off shares name, ua, and full ip", () => {
    const msg = buildInitialProfileMessage(
      { name: "Alice", privacyLevel: "off" },
      CHROME_MAC_UA,
      ADDRESS_V4,
      1,
    );
    expect(msg).toEqual({ name: "Alice", ua: CHROME_MAC_UA, ip: "203.0.113.7", protocol: "IPv4" });
  });

  it("On withholds ua but shares full ip", () => {
    const msg = buildInitialProfileMessage(
      { name: "Alice", privacyLevel: "on" },
      CHROME_MAC_UA,
      ADDRESS_V4,
      1,
    );
    expect(msg).toEqual({ name: "Alice", ip: "203.0.113.7", protocol: "IPv4" });
  });

  it("Anonymous withholds ua and masks ip", () => {
    const msg = buildInitialProfileMessage(
      { name: "Alice", privacyLevel: "anonymous" },
      CHROME_MAC_UA,
      ADDRESS_V4,
      1,
    );
    expect(msg).toEqual({ name: "Alice", ip: "203.xxx.xxx.7", protocol: "IPv4" });
  });

  it("omits ip/protocol entirely when no address is known yet, at any level", () => {
    const msg = buildInitialProfileMessage(
      { name: "Alice", privacyLevel: "off" },
      CHROME_MAC_UA,
      NO_ADDRESS,
      1,
    );
    expect(msg).toEqual({ name: "Alice", ua: CHROME_MAC_UA });
  });

  it("stamps a timestamp only for slot 0", () => {
    const fromSlot0 = buildInitialProfileMessage(
      { name: "Alice", privacyLevel: "off" },
      CHROME_MAC_UA,
      NO_ADDRESS,
      0,
    );
    const fromSlot1 = buildInitialProfileMessage(
      { name: "Alice", privacyLevel: "off" },
      CHROME_MAC_UA,
      NO_ADDRESS,
      1,
    );
    expect(typeof fromSlot0.timestamp).toBe("string");
    expect(Number.isNaN(Date.parse(fromSlot0.timestamp!))).toBe(false);
    expect(fromSlot1.timestamp).toBeUndefined();
  });
});

describe("buildEnrichmentProfileMessage", () => {
  it("Anonymous projects geo down to proxy/hosting only", () => {
    const msg = buildEnrichmentProfileMessage(
      { name: "Alice", privacyLevel: "anonymous" },
      CHROME_MAC_UA,
      ADDRESS_V4,
      { country: "Testland", city: "Testville", proxy: false, hosting: true, lat: 1, lon: 2 },
    );
    expect(msg.geo).toEqual({ proxy: false, hosting: true });
    expect(msg.ua).toBeUndefined();
    expect(msg.ip).toBe("203.xxx.xxx.7");
  });

  it("Off and On pass geo through untouched", () => {
    const geo = { country: "Testland" };
    const msg = buildEnrichmentProfileMessage(
      { name: "Alice", privacyLevel: "off" },
      CHROME_MAC_UA,
      ADDRESS_V4,
      geo,
    );
    expect(msg.geo).toEqual(geo);
  });

  it("omits geo entirely when the lookup failed", () => {
    const msg = buildEnrichmentProfileMessage(
      { name: "Alice", privacyLevel: "off" },
      CHROME_MAC_UA,
      ADDRESS_V4,
      null,
    );
    expect(msg.geo).toBeUndefined();
  });
});

describe("sanitizeIncomingProfile", () => {
  it("passes through a well-formed profile", () => {
    expect(
      sanitizeIncomingProfile({
        name: "Bob",
        ua: "some-ua",
        ip: "203.0.113.9",
        protocol: "IPv4",
        geo: { country: "Testland", lat: 12.5 },
      }),
    ).toEqual({
      name: "Bob",
      ua: "some-ua",
      ip: "203.0.113.9",
      protocol: "IPv4",
      geo: { country: "Testland", lat: 12.5 },
    });
  });

  it("returns null when name is missing or empty after stripping", () => {
    expect(sanitizeIncomingProfile({})).toBeNull();
    expect(sanitizeIncomingProfile({ name: "   " })).toBeNull();
    expect(sanitizeIncomingProfile({ name: "\x00\x01" })).toBeNull();
  });

  it("clamps an over-long name and strips control characters", () => {
    const hostileName = "a\x00b".repeat(40); // way over 60 chars once stripped
    const result = sanitizeIncomingProfile({ name: hostileName });
    expect(result?.name.length).toBeLessThanOrEqual(60);
    expect(result?.name.includes("\x00")).toBe(false);
  });

  it("drops a malformed ip rather than passing it through", () => {
    const result = sanitizeIncomingProfile({ name: "Bob", ip: "<script>alert(1)</script>" });
    expect(result?.ip).toBeUndefined();
  });

  it("accepts full and masked ip forms", () => {
    expect(sanitizeIncomingProfile({ name: "Bob", ip: "203.0.113.9" })?.ip).toBe(
      "203.0.113.9",
    );
    expect(sanitizeIncomingProfile({ name: "Bob", ip: "203.xxx.xxx.9" })?.ip).toBe(
      "203.xxx.xxx.9",
    );
    expect(sanitizeIncomingProfile({ name: "Bob", ip: "2001::xxxx:3965" })?.ip).toBe(
      "2001::xxxx:3965",
    );
  });

  it("drops an unrecognised protocol", () => {
    const result = sanitizeIncomingProfile({ name: "Bob", protocol: "carrier-pigeon" });
    expect(result?.protocol).toBeUndefined();
  });

  it("drops unknown and wrong-typed geo keys without rejecting the whole profile", () => {
    const result = sanitizeIncomingProfile({
      name: "Bob",
      geo: { country: "Testland", evil: "<img onerror=alert(1)>", lat: "not-a-number" },
    });
    expect(result?.geo).toEqual({ country: "Testland" });
  });
});

describe("validateInitialProfile", () => {
  it("slot 0 requires a valid ISO timestamp", () => {
    const withTimestamp = validateInitialProfile(
      { name: "Alice", timestamp: new Date().toISOString() },
      0,
    );
    expect(withTimestamp?.timestamp).toBeDefined();

    expect(validateInitialProfile({ name: "Alice" }, 0)).toBeNull();
    expect(validateInitialProfile({ name: "Alice", timestamp: "not-a-date" }, 0)).toBeNull();
  });

  it("slot 1 needs no timestamp at all", () => {
    const result = validateInitialProfile({ name: "Bob" }, 1);
    expect(result).toEqual({ name: "Bob" });
  });

  it("still fails on a missing name regardless of slot", () => {
    expect(validateInitialProfile({}, 1)).toBeNull();
  });
});

describe("fallbackPeerName", () => {
  it("labels by slot", () => {
    expect(fallbackPeerName(0)).toBe("Peer A");
    expect(fallbackPeerName(1)).toBe("Peer B");
  });
});
