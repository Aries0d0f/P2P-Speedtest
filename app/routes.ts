import { type RouteConfig, index, route } from "@react-router/dev/routes";

// This module is evaluated by the React Router CLI in Node at build time, not
// in the Worker or the browser, so `process` exists here. It is declared
// locally rather than by adding Node types to the app's tsconfig project,
// which would make `process` look available to runtime code too.
declare const process: { env: { NODE_ENV?: string } };

// The Phase 6 visualization harness is a development fixture, not a product
// surface: it is registered only when this config is evaluated outside a
// production build, so `react-router build` never emits the route or its
// chunk. See `app/routes/dev.live-view.tsx`.
const devRoutes: RouteConfig =
  process.env.NODE_ENV === "production" ? [] : [route("dev/live-view", "routes/dev.live-view.tsx")];

export default [
  index("routes/home.tsx"),
  route("room/:slug", "routes/room.tsx"),
  route("results", "routes/results.tsx"),
  route("results/:room/:peerId", "routes/results.$room.$peerId.tsx"),
  ...devRoutes,
] satisfies RouteConfig;
