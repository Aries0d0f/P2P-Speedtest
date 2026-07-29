import { afterEach, describe, expect, it, vi } from "vitest";
import { mintTurnCredentials } from "./turn-provider";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mintTurnCredentials", () => {
  it("returns null when neither secret is set", async () => {
    expect(await mintTurnCredentials({}, 300)).toBeNull();
  });

  it("returns null when only the key id is set", async () => {
    const result = await mintTurnCredentials(
      { TURN_PROVIDER_APP_ID: "key-id" },
      300,
    );
    expect(result).toBeNull();
  });

  it("calls the Cloudflare Calls endpoint with the capped TTL and returns a filtered RTCIceServer", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe(
        "https://rtc.live.cloudflare.com/v1/turn/keys/key-id/credentials/generate",
      );
      expect(init?.headers).toMatchObject({ Authorization: "Bearer key-secret" });
      expect(JSON.parse(init?.body as string)).toEqual({ ttl: 300 });
      return new Response(
        JSON.stringify({
          iceServers: {
            urls: [
              "turn:turn.cloudflare.com:3478?transport=udp",
              "turn:turn.cloudflare.com:53?transport=udp",
              "turns:turn.cloudflare.com:5349?transport=tcp",
              "turns:turn.cloudflare.com:443?transport=tcp",
            ],
            username: "1738035200:user123",
            credential: "base64==",
          },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await mintTurnCredentials(
      { TURN_PROVIDER_APP_ID: "key-id", TURN_PROVIDER_APP_SECRET: "key-secret" },
      300,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toEqual({
      urls: [
        "turn:turn.cloudflare.com:3478?transport=udp",
        "turns:turn.cloudflare.com:5349?transport=tcp",
        "turns:turn.cloudflare.com:443?transport=tcp",
      ],
      username: "1738035200:user123",
      credential: "base64==",
    });
  });

  it("returns null on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    const result = await mintTurnCredentials(
      { TURN_PROVIDER_APP_ID: "id", TURN_PROVIDER_APP_SECRET: "secret" },
      300,
    );
    expect(result).toBeNull();
  });

  it("returns null when fetch itself throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const result = await mintTurnCredentials(
      { TURN_PROVIDER_APP_ID: "id", TURN_PROVIDER_APP_SECRET: "secret" },
      300,
    );
    expect(result).toBeNull();
  });
});
