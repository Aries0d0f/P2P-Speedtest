import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    cloudflareTest({
      main: "./workers/app.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
});
