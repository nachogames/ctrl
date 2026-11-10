import type { EnvironmentId } from "@t3tools/contracts";
import type { ReviewWritingStyle } from "@t3tools/shared/reviewWritingStyles";

import ChatMarkdown from "../../ChatMarkdown";

const LABEL = "text-2xs font-medium tracking-wider text-muted-foreground uppercase";

/** A read-only look at a writing style: what it is for, a sample finding, and its rules. */
export function ReviewStylePreview({
  style,
  environmentId,
}: {
  style: ReviewWritingStyle;
  environmentId: EnvironmentId | undefined;
}) {
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5 text-sm leading-relaxed">
      <p className="text-xs text-muted-foreground">{style.description}</p>
      {style.example === null ? null : (
        <div className="flex flex-col gap-1">
          <p className={LABEL}>Example</p>
          <ChatMarkdown text={style.example} cwd={undefined} environmentId={environmentId} />
        </div>
      )}
      <div className="flex flex-col gap-1">
        <p className={LABEL}>Rules the agent follows</p>
        <ChatMarkdown text={style.rules} cwd={undefined} environmentId={environmentId} />
      </div>
    </div>
  );
}
