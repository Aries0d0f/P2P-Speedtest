import type { TestConfigPayload } from "~/lib/protocol";

/**
 * The service's current test parameters. A room snapshots this once at
 * claim time (1.2) and replays that stored snapshot on every accept, so a
 * deployment change never splits one room's peers across two configs.
 *
 * `chunkBytes` is kept well under any browser's negotiated SCTP
 * max-message-size (04-throughput revision): throughput now comes from
 * `BULK_CONNECTION_COUNT` parallel `RTCPeerConnection`s (each with its own
 * bulk channel), not from pushing a single message as large as possible, so
 * there's no reason to spend that cross-browser risk (older/mobile Safari
 * in particular has shipped with meaningfully smaller negotiated limits
 * than Chrome/Firefox).
 *
 * Real service configuration is Phase 4's concern; the setter below exists
 * so tests can change the "current" value between two claims and confirm
 * the snapshot-at-claim behavior.
 */
let current: TestConfigPayload = {
  maxDurationMs: 30_000,
  maxBytes: 250_000_000,
  chunkBytes: 16_384,
};

export function getCurrentTestConfig(): TestConfigPayload {
  return current;
}

export function setCurrentTestConfigForTesting(
  config: TestConfigPayload,
): void {
  current = config;
}
