/**
 * TURN provider adapter (2.1). Exactly one exported function; every
 * Cloudflare-Calls-specific request/response shape stays in this file so
 * the DO never has to know how a TURN credential was obtained. Swapping
 * providers means rewriting this file, not its caller.
 */
import http from "@aries0d0f/fetch-worker";

const CREDENTIALS_ENDPOINT = (keyId: string) =>
  `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate`;

// Cloudflare's port 53 TURN/STUN URLs are blocked by Chrome and Firefox;
// offering them wastes an ICE candidate attempt rather than helping one.
// A plain `:53` substring check would also reject port 5349 (TLS) — the
// port must be matched as its own token, not a prefix.
function isBrowserUsable(url: string): boolean {
  const match = url.match(/:(\d+)(?:\?|$)/);
  return match ? match[1] !== "53" : true;
}

interface CloudflareTurnCredentialsResponse {
  iceServers: {
    urls: string[];
    username: string;
    credential: string;
  };
}

/**
 * Mints one short-lived TURN credential from Cloudflare's Calls TURN
 * service, scoped to `ttlSeconds` (already capped to the room's remaining
 * lifetime by the caller — this function has no notion of room lifetimes).
 *
 * Returns `null` on a missing key, a non-2xx response, or any network
 * failure, so the caller can fall back to STUN-only rather than blocking
 * the run.
 */
export async function mintTurnCredentials(
  env: Pick<Env, "TURN_PROVIDER_APP_ID" | "TURN_PROVIDER_APP_SECRET">,
  ttlSeconds: number,
): Promise<RTCIceServer | null> {
  const keyId = env.TURN_PROVIDER_APP_ID;
  const keySecret = env.TURN_PROVIDER_APP_SECRET;
  if (!keyId || !keySecret) return null;

  const { data, error } = await http
    .post<CloudflareTurnCredentialsResponse, { ttl: number }>(
      CREDENTIALS_ENDPOINT(keyId),
      { ttl: ttlSeconds },
      {
        headers: {
          Authorization: `Bearer ${keySecret}`,
          "Content-Type": "application/json",
        },
      },
    )
    .then((res) => res.json())
    .then((res) => ({
      urls: res?.iceServers?.urls?.filter(isBrowserUsable),
      username: res?.iceServers?.username,
      credential: res?.iceServers?.credential,
    }))
    .then((data) =>
      data.urls && data.urls.length > 0
        ? { data, error: null }
        : { data: null, error: null },
    )
    .catch((err) => ({ data: null, error: err }));

  if (error) return null;

  return data;
}
