import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import {
  pluginViewErrorMessage,
  pluginViewInitMessage,
  pluginViewResultMessage,
  readPluginViewMessage,
} from "@t3tools/shared/pluginView";
import { useEffect, useState } from "react";

import type { PluginViewSurface } from "~/rightPanelStore";
import { pluginEnvironment } from "~/state/plugins";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { HtmlRenderDocument } from "../files/BrowserDocumentFrame";

/**
 * A plugin's view in the right panel: its page in the sandboxed, themed frame
 * agent HTML renders use, answering the page's `t3.call` through the plugin.
 * The page is read again whenever the plugin's files change.
 */
export function PluginViewPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | undefined;
  readonly surface: PluginViewSurface;
}) {
  const { environmentId, surface } = props;
  const threadId = props.threadRef?.threadId ?? null;
  const plugin = useEnvironmentQuery(
    pluginEnvironment.snapshot({ environmentId, input: {} }),
  ).data?.plugins.find((candidate) => candidate.id === surface.pluginId);
  const offersView =
    plugin !== undefined &&
    plugin.state !== "disabled" &&
    plugin.state !== "error" &&
    plugin.views.some((view) => view.id === surface.viewId);
  const view = useEnvironmentQuery(
    offersView
      ? pluginEnvironment.view({
          environmentId,
          input: { pluginId: surface.pluginId, viewId: surface.viewId, revision: plugin.revision },
        })
      : null,
  );
  const html = view.data?.html ?? null;

  const callView = useAtomCommand(pluginEnvironment.callView, {
    reportFailure: false,
    reportDefect: false,
  });
  const onFrameMessage = (data: unknown, reply: (message: unknown) => void) => {
    const message = readPluginViewMessage(data);
    if (message === undefined) return;
    if (message.type === "ready") {
      reply(
        pluginViewInitMessage({ pluginId: surface.pluginId, viewId: surface.viewId, threadId }),
      );
      return;
    }
    void callView({
      environmentId,
      input: {
        pluginId: surface.pluginId,
        viewId: surface.viewId,
        handler: message.handler,
        input: message.input,
        ...(threadId === null ? {} : { threadId }),
      },
    }).then((result) =>
      reply(
        result._tag === "Success"
          ? pluginViewResultMessage(message.id, result.value.value)
          : pluginViewErrorMessage(message.id, failureMessage(squashAtomCommandFailure(result))),
      ),
    );
  };

  const notice =
    plugin === undefined
      ? "This plugin is no longer installed."
      : plugin.state === "disabled"
        ? `${plugin.name} is turned off. Turn it on in Settings → Plugins.`
        : plugin.state === "error"
          ? `${plugin.name} failed to load: ${plugin.error ?? "unknown error"}`
          : !offersView
            ? `${plugin.name} no longer has this view.`
            : view.error;

  if (notice !== null && notice !== undefined) {
    return (
      <p className="m-auto max-w-sm p-6 text-center text-muted-foreground text-sm whitespace-pre-wrap">
        {notice}
      </p>
    );
  }
  if (html === null) return null;
  return (
    <PluginViewFrame
      key={html}
      html={html}
      title={surface.title}
      threadRef={props.threadRef}
      onFrameMessage={onFrameMessage}
    />
  );
}

/** Keyed by the HTML, so each version gets its own blob URL, revoked when it is replaced. */
function PluginViewFrame(props: {
  readonly html: string;
  readonly title: string;
  readonly threadRef: ScopedThreadRef | undefined;
  readonly onFrameMessage: (data: unknown, reply: (message: unknown) => void) => void;
}) {
  const [src] = useState(() => URL.createObjectURL(new Blob([props.html], { type: "text/html" })));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases this frame's blob URL on unmount
  useEffect(() => () => URL.revokeObjectURL(src), [src]);
  return (
    <HtmlRenderDocument
      src={src}
      title={props.title}
      threadRef={props.threadRef}
      className="min-h-0 flex-1"
      onFrameMessage={props.onFrameMessage}
    />
  );
}

const failureMessage = (failure: unknown): string =>
  typeof failure === "object" &&
  failure !== null &&
  "message" in failure &&
  typeof failure.message === "string"
    ? failure.message
    : "The plugin call failed.";
