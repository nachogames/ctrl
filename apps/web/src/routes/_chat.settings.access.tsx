import { createFileRoute, redirect } from "@tanstack/react-router";

// Sharing & access merged into Connections; old links and bookmarks land there.
export const Route = createFileRoute("/_chat/settings/access")({
  beforeLoad: ({ location }) => {
    throw redirect({ to: "/settings/connections", hash: location.hash, replace: true });
  },
});
