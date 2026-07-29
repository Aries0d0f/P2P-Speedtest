import { createRequestHandler } from "react-router";
import {
  generateToken,
  slugToToken,
  tokenToEmojiKey,
  tokenToSlug,
} from "~/lib/room-token";

export { SignalingRoom } from "./signaling-room";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

const MAX_CLAIM_ATTEMPTS = 5;

function sourceIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

let generateTokenImpl = generateToken;

/** Test-only hook: lets a test force a collision on the first attempt(s)
 * without controlling the real CSPRNG. */
export function setTokenGeneratorForTesting(impl: () => number): void {
  generateTokenImpl = impl;
}

/**
 * POST /api/rooms: rate limit -> generate -> claim -> retry on collision
 * (capped at 5, since a collision at 42 bits means a bug, not bad luck).
 */
async function handleCreateRoom(request: Request, env: Env): Promise<Response> {
  const { success } = await env.CREATE_RATE_LIMITER.limit({ key: sourceIp(request) });
  if (!success) {
    return new Response("Too Many Requests", {
      status: 429,
      headers: { "Retry-After": "60" },
    });
  }

  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
    const token = generateTokenImpl();
    const slug = tokenToSlug(token);
    const claimed = await env.SIGNALING_ROOM.getByName(slug).claim(slug);
    if (claimed) {
      const emojiKey = tokenToEmojiKey(token);
      const link = `${new URL(request.url).origin}/room/${slug}`;
      return Response.json({ slug, emojiKey, link }, { status: 201 });
    }
  }
  return new Response("Service Unavailable", { status: 503 });
}

/**
 * /api/room/:roomToken: the join rate limit counts every upgrade attempt,
 * even ones rejected afterwards, so it runs before token validation and
 * before any DO work. A non-upgrade request never touches the limiter or
 * the DO at all.
 */
async function handleRoomUpgrade(
  request: Request,
  env: Env,
  roomToken: string,
): Promise<Response> {
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("Upgrade Required", { status: 426 });
  }

  const { success } = await env.JOIN_RATE_LIMITER.limit({ key: sourceIp(request) });
  if (!success) {
    return new Response("Too Many Requests", { status: 429 });
  }

  const token = slugToToken(roomToken);
  if (token === null) {
    return new Response("Invalid room token", { status: 400 });
  }

  const slug = tokenToSlug(token); // canonical spelling, regardless of lenient input
  return env.SIGNALING_ROOM.getByName(slug).fetch(request);
}

const ROOM_UPGRADE_PATH = /^\/api\/room\/([^/]+)\/?$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/rooms" && request.method === "POST") {
      return handleCreateRoom(request, env);
    }

    const roomMatch = url.pathname.match(ROOM_UPGRADE_PATH);
    if (roomMatch) {
      return handleRoomUpgrade(request, env, roomMatch[1]);
    }

    if (url.pathname.startsWith("/api/")) {
      return new Response("Not Found", { status: 404 });
    }

    return requestHandler(request);
  },
} satisfies ExportedHandler<Env>;
