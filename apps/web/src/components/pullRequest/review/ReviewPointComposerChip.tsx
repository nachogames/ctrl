import { MessageSquareDotIcon, XIcon } from "lucide-react";
import type { PointerEvent } from "react";

import { ComposerBanner } from "../../chat/ComposerBanner";
import { ContextChip, ContextChipAction, ContextChipLabel } from "../../ContextChip";
import { useReviewPointFocusStore } from "./reviewPointFocusStore";

// Clicks on the chip keep the caret in the composer.
const keepComposerFocus = (event: PointerEvent) => event.preventDefault();

/**
 * The point open in the Review tab, attached to the review chat's next messages. Shown only in
 * the review chat and only while a point is open; × detaches it without closing the point, and
 * the dashed chip attaches it again.
 */
export function ReviewPointComposerChip({ threadKey }: { threadKey: string }) {
  const focus = useReviewPointFocusStore((state) =>
    state.reviewChats[threadKey] === undefined ? undefined : state.focus[threadKey],
  );
  if (focus === undefined) return null;
  const name = `#${focus.number} ${focus.label}`;
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root data-review-point-chip={focus.detached ? "detached" : "attached"}>
        <ComposerBanner.Row>
          <ComposerBanner.Icon>
            <MessageSquareDotIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            {focus.detached ? (
              <ContextChip
                kind="review-comment"
                state="unresolved"
                render={<button type="button" />}
                aria-label={`Talk about ${name} again`}
                onPointerDown={keepComposerFocus}
                onClick={() => useReviewPointFocusStore.getState().attach(threadKey)}
              >
                <ContextChipLabel>+ {name}</ContextChipLabel>
              </ContextChip>
            ) : (
              <ContextChip kind="review-comment">
                <ContextChipLabel>{name}</ContextChipLabel>
                <ContextChipAction
                  aria-label="Talk about no point"
                  onPointerDown={keepComposerFocus}
                  onClick={() => useReviewPointFocusStore.getState().detach(threadKey)}
                >
                  <XIcon aria-hidden="true" />
                </ContextChipAction>
              </ContextChip>
            )}
            <span className="min-w-0 truncate text-muted-foreground">
              {focus.detached
                ? "Messages are about no point"
                : "Ask about this point, or tell me what to change"}
            </span>
          </ComposerBanner.Content>
        </ComposerBanner.Row>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
