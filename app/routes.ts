import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("room/:slug", "routes/room.tsx"),
  route("results", "routes/results.tsx"),
  route("results/:room/:peerId", "routes/results.$room.$peerId.tsx"),
] satisfies RouteConfig;
