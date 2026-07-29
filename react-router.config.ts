import type { Config } from "@react-router/dev/config";

export default {
  // No runtime server rendering: routes.ts has only "/" (static) and
  // "/room/:slug" (dynamic, driven entirely by clientLoader). Only "/" is
  // pre-rendered to static HTML; "/room/:slug" is served from the
  // generated SPA fallback shell instead (see workers/app.ts).
  ssr: false,
  async prerender() {
    return ["/"];
  },
} satisfies Config;
