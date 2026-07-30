import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Two projects because Phase 6 needs both: the pre-existing protocol/logic
// suites keep running inside workerd (the same runtime as the Worker/DO code
// they exercise), while the browser-only visualization components need a real
// DOM. Only `.test.tsx` opts into jsdom, so a new `.test.ts` still lands in
// the workers pool by default.
export default defineConfig({
  test: {
    projects: [
      {
        resolve: {
          tsconfigPaths: true,
        },
        plugins: [
          cloudflareTest({
            main: "./workers/app.ts",
            wrangler: { configPath: "./wrangler.jsonc" },
          }),
        ],
        test: {
          name: "workers",
          include: ["app/**/*.test.ts", "workers/**/*.test.ts"],
        },
      },
      {
        resolve: {
          tsconfigPaths: true,
        },
        plugins: [react()],
        test: {
          name: "dom",
          include: ["app/**/*.test.tsx"],
          environment: "jsdom",
          setupFiles: ["./test/setup-dom.ts"],
        },
      },
    ],
  },
});
