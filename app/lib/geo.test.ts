import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectGeoForAnonymous, sanitizeGeo } from "~/model/geo.model";
import { resolveOwnAddress } from "~/model/connection.model";
import {
  fetchSelfLookup,
  peekSelfAddress,
  prefetchSelfLookup,
  resetSelfLookupPrefetch,
} from "./geo";

beforeEach(() => {
  resetSelfLookupPrefetch();
});

/** The lookup's geo half, which most of these cases are about. */
async function fetchGeo() {
  return (await fetchSelfLookup())?.geo ?? null;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function respondWith(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("fetchSelfLookup", () => {
  it("fetches from the geo proxy and sanitizes the response", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe("https://ip.aries0d0f.me/?q=geo");
      return new Response(
        JSON.stringify({ country: "Testland", lat: 10, lon: 20, proxy: false }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await fetchGeo()).toEqual({
      country: "Testland",
      lat: 10,
      lon: 20,
      proxy: false,
    });
  });

  it("unwraps the endpoint's { ip, protocol, geo } envelope", async () => {
    // The real response shape. Reading `lat`/`lon` off the top level found
    // nothing, so every lookup returned null and every peer looked as though
    // it had withheld its location regardless of privacy level.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ip: "1.161.11.102",
              protocol: "IPv4",
              geo: {
                status: "success",
                country: "Taiwan",
                countryCode: "TW",
                city: "New Taipei City",
                lat: 25.0693,
                lon: 121.4626,
                proxy: false,
                hosting: false,
              },
            }),
            { status: 200 },
          ),
      ),
    );

    const geo = await fetchGeo();
    expect(geo).not.toBeNull();
    expect(geo!.lat).toBe(25.0693);
    expect(geo!.lon).toBe(121.4626);
    expect(geo!.city).toBe("New Taipei City");
    // `status` and the envelope's own fields are not schema-known and are
    // dropped by the same sanitizer as before.
    expect(geo).not.toHaveProperty("status");
    expect(geo).not.toHaveProperty("ip");
  });

  it("returns null when the envelope carries no usable geo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ip: "1.2.3.4", protocol: "IPv4" }), { status: 200 })),
    );
    expect(await fetchGeo()).toBeNull();
  });

  it("never throws — returns null on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    expect(await fetchGeo()).toBeNull();
  });

  it("never throws — returns null when fetch itself rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("blocked");
      }),
    );
    expect(await fetchGeo()).toBeNull();
  });

  it("reads the envelope's address, so an `ip` is in hand before ICE has one", async () => {
    respondWith({ ip: "1.161.11.102", protocol: "IPv4", geo: { city: "New Taipei City" } });
    expect((await fetchSelfLookup())?.address).toEqual({
      ip: "1.161.11.102",
      protocol: "IPv4",
    });
  });

  it("infers the family when the envelope omits `protocol`", async () => {
    respondWith({ ip: "2001:b011:3804::d0f" });
    expect((await fetchSelfLookup())?.address).toEqual({
      ip: "2001:b011:3804::d0f",
      protocol: "IPv6",
    });
  });

  it("drops an address that isn't a valid IP — this is a network response", async () => {
    respondWith({ ip: "<script>", protocol: "IPv4", geo: { city: "New Taipei City" } });
    const lookup = await fetchSelfLookup();
    expect(lookup?.address).toEqual({});
    // …and the geo half still survives on its own.
    expect(lookup?.geo).toEqual({ city: "New Taipei City" });
  });
});

describe("sanitizeGeo", () => {
  it("keeps only schema-known fields of the right type", () => {
    expect(
      sanitizeGeo({
        country: "Testland",
        lat: 200, // out of range, dropped
        lon: 20,
        mobile: "yes", // wrong type, dropped
        evil: "<script>", // unknown key, dropped
      }),
    ).toEqual({ country: "Testland", lon: 20 });
  });

  it("returns null for a non-object or fully-empty result", () => {
    expect(sanitizeGeo(null)).toBeNull();
    expect(sanitizeGeo("nope")).toBeNull();
    expect(sanitizeGeo({})).toBeNull();
  });
});

describe("projectGeoForAnonymous", () => {
  it("keeps only proxy/hosting", () => {
    expect(
      projectGeoForAnonymous({
        country: "Testland",
        city: "Testville",
        proxy: true,
        hosting: false,
      }),
    ).toEqual({ proxy: true, hosting: false });
  });

  it("returns undefined when there is nothing left to project", () => {
    expect(projectGeoForAnonymous({ country: "Testland" })).toBeUndefined();
    expect(projectGeoForAnonymous(null)).toBeUndefined();
  });
});

describe("prefetchSelfLookup", () => {
  const PAYLOAD = {
    ip: "1.161.11.102",
    protocol: "IPv4",
    geo: { city: "New Taipei City", lat: 25.0693, lon: 121.4626 },
  };

  it("looks up once and shares the answer with every later caller", async () => {
    const fetchMock = respondWith(PAYLOAD);

    // The room page starts this at mount; the control channel awaits it later.
    const [atMount, atChannelOpen] = await Promise.all([
      prefetchSelfLookup(),
      prefetchSelfLookup(),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(atMount).toEqual(atChannelOpen);
    expect(atMount.geo?.lat).toBe(25.0693);
    expect(atMount.address.ip).toBe("1.161.11.102");

    // And a caller arriving after it has already settled still pays nothing.
    expect(await prefetchSelfLookup()).toEqual(atMount);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries after a failure rather than caching it", async () => {
    // The whole point of prefetching is that the lookup happens early — which
    // is also when the network is least settled. A transient failure at mount
    // must not doom the one that matters, at channel-open time.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect(await prefetchSelfLookup()).toEqual({ address: {}, geo: null });

    const fetchMock = respondWith(PAYLOAD);
    expect((await prefetchSelfLookup()).geo?.lat).toBe(25.0693);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shares nothing on its own — the caller still projects by privacy level", async () => {
    respondWith(PAYLOAD);
    const { geo } = await prefetchSelfLookup();
    // Full coordinates sit in the module; Anonymous still gets nothing from
    // them, because the projection happens where the message is built.
    expect(geo?.lat).toBe(25.0693);
    expect(projectGeoForAnonymous(geo)).toBeUndefined();
  });
});

describe("peekSelfAddress", () => {
  const PAYLOAD = { ip: "1.161.11.102", protocol: "IPv4", geo: { city: "New Taipei City" } };

  it("answers empty until the prefetch lands, then answers with it", async () => {
    respondWith(PAYLOAD);
    // The initial profile may consult the prefetch but must never wait on it:
    // it gates pairing.
    const pending = prefetchSelfLookup();
    expect(peekSelfAddress()).toEqual({});

    await pending;
    expect(peekSelfAddress()).toEqual({ ip: "1.161.11.102", protocol: "IPv4" });
  });

  it("stands in for an ICE address that hasn't gathered yet", async () => {
    respondWith(PAYLOAD);
    await prefetchSelfLookup();

    // No srflx candidate at channel-open time — the case where `ip` used to go
    // missing from the profile entirely.
    expect(resolveOwnAddress({}, peekSelfAddress())).toEqual({
      ip: "1.161.11.102",
      protocol: "IPv4",
    });

    // Once ICE has an answer it wins: it describes the path actually used.
    expect(
      resolveOwnAddress({ ip: "203.0.113.7", protocol: "IPv4" }, peekSelfAddress()),
    ).toEqual({ ip: "203.0.113.7", protocol: "IPv4" });
  });
});
