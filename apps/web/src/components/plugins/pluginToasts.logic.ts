import type { PluginToast } from "@t3tools/contracts";

/**
 * The toasts to show from a new frame, and the ids now seen. The first frame
 * (`seen` null) shows nothing: those toasts were sent before this client
 * connected. Ids the server no longer retains are forgotten.
 */
export function unseenPluginToasts(
  toasts: ReadonlyArray<PluginToast>,
  seen: ReadonlySet<string> | null,
): { readonly show: ReadonlyArray<PluginToast>; readonly seen: ReadonlySet<string> } {
  const ids = new Set(toasts.map((toast) => toast.id));
  if (seen === null) return { show: [], seen: ids };
  return { show: toasts.filter((toast) => !seen.has(toast.id)), seen: ids };
}
