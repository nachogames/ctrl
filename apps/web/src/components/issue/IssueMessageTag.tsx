import type { ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { CircleDotIcon } from "lucide-react";

import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

import { InlineButton } from "../ui/button";

/**
 * The issue a sent message was about, above its bubble. Opens the issue beside the chat when the
 * chat still has it as a tab, otherwise on the tracker.
 */
export function IssueMessageTag({
  threadRef,
  tag,
}: {
  threadRef: ScopedThreadRef | null;
  tag: { readonly key: string; readonly url: string | null };
}) {
  const gt = useGT();
  const surface = useRightPanelStore((state) =>
    threadRef === null
      ? undefined
      : selectThreadRightPanelState(state.byThreadKey, threadRef).surfaces.find(
          (entry) => entry.kind === "issue" && entry.key === tag.key,
        ),
  );
  const label = (
    <>
      <CircleDotIcon aria-hidden className="size-3" />
      <span className="font-mono">{tag.key}</span>
    </>
  );
  if (threadRef !== null && surface?.kind === "issue") {
    return (
      <p className="me-1 text-2xs">
        <InlineButton
          tone="muted"
          aria-label={gt("Open {issue} beside the chat", { issue: tag.key })}
          onClick={() => useRightPanelStore.getState().openIssue(threadRef, surface)}
        >
          {label}
        </InlineButton>
      </p>
    );
  }
  if (tag.url !== null) {
    return (
      <p className="me-1 text-2xs">
        <InlineButton
          tone="muted"
          aria-label={gt("Open {issue} on its tracker", { issue: tag.key })}
          render={<a href={tag.url} target="_blank" rel="noopener noreferrer" />}
        >
          {label}
        </InlineButton>
      </p>
    );
  }
  return <p className="me-1 flex items-center gap-1 text-2xs text-muted-foreground">{label}</p>;
}
