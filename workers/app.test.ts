import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { slugToToken } from "~/lib/room-token";
import { setTokenGeneratorForTesting } from "./app";

function ip(addr: string): HeadersInit {
  return { "CF-Connecting-IP": addr };
}

// DO storage persists across tests in this file (each claimed slug stays
// claimed), so the default generator must never repeat a token across
// tests. A shared, ever-increasing counter guarantees that; the one test
// that specifically wants a collision overrides it with fixed values.
let nextToken = 10_000;
beforeEach(() => {
  setTokenGeneratorForTesting(() => nextToken++);
});

describe("POST /api/rooms", () => {
  it("creates a room whose slug and emoji key encode the same token", async () => {
    const resp = await SELF.fetch("http://example.com/api/rooms", {
      method: "POST",
      headers: ip("203.0.113.1"),
    });
    expect(resp.status).toBe(201);
    const body = await resp.json<{ slug: string; emojiKey: string; link: string }>();
    expect(body.slug).toMatch(/^[0-9A-Z]{9}$/);
    expect(body.link.endsWith(`/room/${body.slug}`)).toBe(true);
  });

  it("retries when the generated token collides with an already-claimed room", async () => {
    // Force attempt 1 and attempt 2 to generate the SAME token (a forced
    // collision with itself would just mean claim() is called twice for
    // the same room, and the second call legitimately fails since the
    // first claim already succeeded), then attempt 3 gets a fresh token.
    let calls = 0;
    setTokenGeneratorForTesting(() => {
      calls++;
      return calls === 1 || calls === 2 ? 42 : 43;
    });

    const first = await SELF.fetch("http://example.com/api/rooms", {
      method: "POST",
      headers: ip("203.0.113.2"),
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json<{ slug: string }>();
    expect(slugToToken(firstBody.slug)).toBe(42);

    // A second creation attempt now collides on token 42 (attempt 1) and
    // must retry to token 43 (attempt 2).
    const second = await SELF.fetch("http://example.com/api/rooms", {
      method: "POST",
      headers: ip("203.0.113.3"),
    });
    expect(second.status).toBe(201);
    const secondBody = await second.json<{ slug: string }>();
    expect(slugToToken(secondBody.slug)).toBe(43);
  });

  it("rate-limits room creation per IP", async () => {
    const addr = "203.0.113.10";
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const resp = await SELF.fetch("http://example.com/api/rooms", {
        method: "POST",
        headers: ip(addr),
      });
      statuses.push(resp.status);
      if (resp.status === 429) {
        expect(resp.headers.get("Retry-After")).toBeTruthy();
      }
    }
    expect(statuses.filter((s) => s === 201)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(1);
  });
});

describe("/api/room/:roomToken", () => {
  it("returns 426 when the request does not ask to upgrade", async () => {
    const resp = await SELF.fetch("http://example.com/api/room/000000001", {
      headers: ip("203.0.113.20"),
    });
    expect(resp.status).toBe(426);
  });

  it("returns 400 for a syntactically invalid room token", async () => {
    const resp = await SELF.fetch("http://example.com/api/room/not-a-token", {
      headers: { ...ip("203.0.113.21"), Upgrade: "websocket" },
    });
    expect(resp.status).toBe(400);
  });

  it("returns 404 for a well-formed token that was never claimed", async () => {
    const resp = await SELF.fetch("http://example.com/api/room/00000000A", {
      headers: { ...ip("203.0.113.22"), Upgrade: "websocket" },
    });
    expect(resp.status).toBe(404);
  });

  it("upgrades a real room end to end and resolves a mistyped slug to the same room", async () => {
    const create = await SELF.fetch("http://example.com/api/rooms", {
      method: "POST",
      headers: ip("203.0.113.23"),
    });
    const { slug } = await create.json<{ slug: string }>();

    const resp = await SELF.fetch(`http://example.com/api/room/${slug}`, {
      headers: { ...ip("203.0.113.24"), Upgrade: "websocket" },
    });
    expect(resp.status).toBe(101);
    expect(resp.webSocket).toBeTruthy();

    // A lenient/mistyped spelling of the same slug must resolve to the
    // same room, not a 404.
    const lenient = slug.toLowerCase();
    const resp2 = await SELF.fetch(`http://example.com/api/room/${lenient}`, {
      headers: { ...ip("203.0.113.25"), Upgrade: "websocket" },
    });
    expect(resp2.status).toBe(101);
  });

  it("rate-limits join/upgrade attempts per IP, counting rejected attempts", async () => {
    const addr = "203.0.113.30";
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const resp = await SELF.fetch("http://example.com/api/room/not-a-token", {
        headers: { ...ip(addr), Upgrade: "websocket" },
      });
      statuses.push(resp.status);
    }
    expect(statuses.filter((s) => s === 400)).toHaveLength(20);
    expect(statuses.filter((s) => s === 429)).toHaveLength(1);
  });
});

describe("other /api/* paths", () => {
  it("returns 404 for anything not matching the explicit dispatch table", async () => {
    const paths = ["/api/rooms", "/api/whatever", "/api/room/"];
    for (const path of paths) {
      const resp = await SELF.fetch(`http://example.com${path}`, {
        headers: ip("203.0.113.40"),
      }); // GET, not POST — none of these match a defined route
      expect(resp.status).toBe(404);
    }
  });
});
