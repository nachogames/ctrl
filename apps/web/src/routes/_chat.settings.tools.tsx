import { createFileRoute } from "@tanstack/react-router";

import { ToolsSettingsPanel } from "../components/settings/RemoteMcpSettings";

export const Route = createFileRoute("/_chat/settings/tools")({
  component: ToolsSettingsPanel,
});
