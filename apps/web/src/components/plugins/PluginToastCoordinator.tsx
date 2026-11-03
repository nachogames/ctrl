import type { EnvironmentId, PluginToast } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { useEnvironments } from "~/state/environments";
import { pluginEnvironment } from "~/state/plugins";
import { useEnvironmentQuery } from "~/state/query";

import { toastManager } from "../ui/toast";
import { unseenPluginToasts } from "./pluginToasts.logic";

/** Shows each toast a plugin or Claude Code mod sends, once, on every connected environment. */
export function PluginToastCoordinator() {
  const { environments } = useEnvironments();
  return environments.map((environment) => (
    <EnvironmentPluginToasts
      key={environment.environmentId}
      environmentId={environment.environmentId}
    />
  ));
}

function EnvironmentPluginToasts(props: { readonly environmentId: EnvironmentId }) {
  const toasts = useEnvironmentQuery(
    pluginEnvironment.snapshot({ environmentId: props.environmentId, input: {} }),
  ).data?.toasts;
  // Null until the first snapshot: toasts already in it predate this client.
  const seen = useRef<ReadonlySet<string> | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- shows new snapshot toasts through the imperative toast manager
  useEffect(() => {
    if (toasts === undefined) return;
    const { show, seen: next } = unseenPluginToasts(toasts, seen.current);
    seen.current = next;
    for (const toast of show) showPluginToast(toast);
  }, [toasts]);
  return null;
}

function showPluginToast(toast: PluginToast) {
  const type = toast.tone === undefined || toast.tone === "neutral" ? "info" : toast.tone;
  toastManager.add({
    type,
    title: toast.source.kind === "plugin" ? `${toast.source.name}: ${toast.title}` : toast.title,
    ...(toast.body === undefined ? {} : { description: toast.body }),
    ...(toast.timeoutMs === undefined ? {} : { timeout: toast.timeoutMs }),
  });
}
