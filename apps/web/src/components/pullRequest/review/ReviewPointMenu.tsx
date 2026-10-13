import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId, ReviewSessionId, ThreadId } from "@t3tools/contracts";
import { EllipsisIcon, SplitIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { waitForThreadShell } from "~/state/entities";
import { reviewSessionEnvironment } from "~/state/reviewSessions";
import { buildThreadRouteParams } from "~/threadRoutes";
import { Button } from "../../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { useReviewCommand } from "./useReviewCommand";

/** Opens a chat the review started, once it has reached this client. */
function useGoToThread(environmentId: EnvironmentId) {
  const navigate = useNavigate();
  return useCallback(
    async (threadId: ThreadId) => {
      const ref = { environmentId, threadId };
      if (!(await waitForThreadShell(ref))) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "The chat has not reached this client yet",
            description: "Open it from the sidebar in a moment.",
          }),
        );
        return;
      }
      await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
    },
    [environmentId, navigate],
  );
}

/** Starts, or finds, the side chat about one point, and goes to it. */
export function useOpenReviewSideChat(environmentId: EnvironmentId) {
  const openSideChat = useReviewCommand(
    reviewSessionEnvironment.discussInSideChat,
    "Could not open its own chat",
  );
  const goToThread = useGoToThread(environmentId);
  const [opening, setOpening] = useState(false);
  const open = async (sessionId: ReviewSessionId, number: number) => {
    if (opening) return;
    setOpening(true);
    const result = await openSideChat({ environmentId, input: { sessionId, number } });
    setOpening(false);
    if (result._tag === "Success") await goToThread(result.value.threadId);
  };
  return { open, opening, goToThread };
}

/** The ⋯ menu on an open point. */
export function ReviewPointMenu({
  environmentId,
  onDiscuss,
  disabled,
}: {
  environmentId: EnvironmentId;
  onDiscuss: () => void;
  disabled: boolean;
}) {
  const canStart = useAtomValue(
    reviewSessionEnvironment.discussInSideChat.permissionAtom(environmentId),
  );
  return (
    <Menu>
      <MenuTrigger
        render={<Button aria-label="More for this point" size="icon-xs" variant="ghost" />}
      >
        <EllipsisIcon aria-hidden="true" />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem disabled={!canStart || disabled} onClick={onDiscuss}>
          <SplitIcon aria-hidden="true" />
          Discuss in its own chat
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/** Shown on a point that has a side chat; its conclusions land back on the point. */
export function ReviewSideChatBanner({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-muted/40 px-2.5 py-1.5 text-xs">
      <SplitIcon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">Being discussed in its own chat.</span>
      <Button size="xs" variant="ghost" onClick={onOpen}>
        Open
      </Button>
    </div>
  );
}
