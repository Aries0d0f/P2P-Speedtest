/**
 * Secrets set via `wrangler secret put` never appear in the generated
 * `worker-configuration.d.ts` (that file only reflects `wrangler.jsonc`
 * bindings), so they're declared here instead. Declaration-merges with the
 * generated `Env` interface.
 */
interface Env {
  /** Cloudflare Calls TURN key id (2.1). Not secret by itself, but stored
   * as a secret alongside its key so nothing about the provider lives in
   * the repo. */
  TURN_PROVIDER_APP_ID?: string;
  /** Cloudflare Calls TURN key secret (2.1). `wrangler secret put`, never
   * committed. */
  TURN_PROVIDER_APP_SECRET?: string;
}
