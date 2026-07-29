import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGeo, projectGeoForAnonymous, sanitizeGeo } from "./geo";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchGeo", () => {
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
