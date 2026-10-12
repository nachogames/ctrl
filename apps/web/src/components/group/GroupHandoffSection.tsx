import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadGroup } from "@t3tools/client-runtime/state/models";
import type { ThreadGroupHandoff, ThreadId } from "@t3tools/contracts";
import { useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";

import { formatElapsedDurationLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { handoffNeedsCollapse, parseHandoffSummary } from "./GroupHandoffSection.logic";
import { splitInlineCode } from "./GroupPanel.logic";

function InlineCode(props: { text: string }) {
  return splitInlineCode(props.text).map((segment) =>
    segment.code ? (
      <code key={segment.start} className="font-mono">
        {segment.text}
      </code>
    ) : (
      <span key={segment.start}>{segment.text}</span>
    ),
  );
}

/** The group's last handoff: three lines until expanded, then its headings as labels. */
export function GroupHandoffSection(props: {
  handoff: ThreadGroupHandoff;
  group: EnvironmentThreadGroup;
  onOpen: (threadId: ThreadId) => void;
}) {
  const { handoff } = props;
  const [expanded, setExpanded] = useState(false);
  const collapsible = handoffNeedsCollapse(handoff.summary);
  const blocks = useMemo(() => parseHandoffSummary(handoff.summary), [handoff.summary]);
  const source = useThreadShell(
    useMemo(
      () => scopeThreadRef(props.group.environmentId, handoff.fromThreadId),
      [props.group.environmentId, handoff.fromThreadId],
    ),
  );
  const sourceTitle = source !== null && source.deletedAt === null ? source.title : null;

  return (
    <div className="px-1.5">
      {collapsible && !expanded ? (
        <p className="line-clamp-3 whitespace-pre-wrap text-foreground text-sm leading-relaxed">
          <InlineCode text={handoff.summary} />
        </p>
      ) : (
        <div className="text-foreground">
          {blocks.map((block) => {
            switch (block.kind) {
              case "heading":
                return (
                  <p
                    key={block.key}
                    className={cn(
                      "mt-2 font-semibold text-xs first:mt-0",
                      block.warning ? "text-warning-foreground" : "text-foreground",
                    )}
                  >
                    {block.label}
                  </p>
                );
              case "text":
                return (
                  <p key={block.key} className="whitespace-pre-wrap text-sm">
                    <InlineCode text={block.text} />
                  </p>
                );
              case "list":
                return (
                  <ul key={block.key} className="list-disc ps-5 text-sm">
                    {block.items.map((item) => (
                      <li key={item}>
                        <InlineCode text={item} />
                      </li>
                    ))}
                  </ul>
                );
            }
          })}
        </div>
      )}
      {collapsible ? (
        <Button
          size="xs"
          variant="ghost-muted"
          className="-ms-2 mt-1"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show more"}
        </Button>
      ) : null}
      <p className="mt-2 text-muted-foreground text-xs">
        {sourceTitle !== null ? (
          <>
            from{" "}
            <button
              type="button"
              className="cursor-pointer text-foreground underline-offset-2 hover:underline"
              onClick={() => props.onOpen(handoff.fromThreadId)}
            >
              {sourceTitle}
            </button>
            {" · "}
          </>
        ) : null}
        {formatElapsedDurationLabel(handoff.at)}
      </p>
    </div>
  );
}
