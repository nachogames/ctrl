import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AuthPreviewOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { loopbackPort } from "@t3tools/shared/threadGroups";
import { useCallback } from "react";

import { isPreviewAvailableFor } from "~/browser/previewRuntime";
import { useOpenLink } from "~/browser/useOpenLink";
import { previewEnvironment } from "~/state/preview";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { openLocalServerUrl } from "../preview/openDiscoveredPort";

/**
 * Opens a group server's URL. A loopback URL names the environment's machine, so
 * it opens in the preview pane, which reaches that machine from a remote client
 * too. Without preview access, and for any other URL, it opens like a link.
 */
export function useOpenServerUrl(threadRef: ScopedThreadRef): (url: string) => Promise<void> {
  const openLink = useOpenLink(threadRef);
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const canPreview = useEnvironmentScope(threadRef.environmentId, AuthPreviewOperateScope);
  return useCallback(
    async (url: string) => {
      if (
        loopbackPort(url) === null ||
        !canPreview ||
        !isPreviewAvailableFor(threadRef.environmentId)
      ) {
        return openLink(url);
      }
      const result = await openLocalServerUrl({ threadRef, url, openPreview });
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
      throw squashAtomCommandFailure(result);
    },
    [canPreview, openLink, openPreview, threadRef],
  );
}
