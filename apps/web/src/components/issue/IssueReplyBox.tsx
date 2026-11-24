import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, IssueRef } from "@t3tools/contracts";
import { msg, T, useGT } from "gt-react";
import { useState } from "react";

import { m } from "~/i18n/messages";
import { issueEnvironment } from "~/state/issues";
import { useAtomCommand } from "~/state/use-atom-command";

import { readableFailure } from "../pullRequest/pullRequestDetail.logic";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";

/** A reply box under one comment, posting a threaded reply to it on the tracker. */
export function IssueReplyBox({
  environmentId,
  reference,
  parentId,
  name,
  onDone,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
  parentId: string;
  /** Who is being answered, for the field's label. */
  name: string;
  onDone: () => void;
}) {
  const gt = useGT();
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);
  const comment = useAtomCommand(issueEnvironment.comment, { reportFailure: false });

  const send = async () => {
    if (body.trim().length === 0 || posting) return;
    setPosting(true);
    const result = await comment({ environmentId, input: { ...reference, body, parentId } });
    setPosting(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: m(msg("The reply could not be posted")),
        description: readableFailure(
          squashAtomCommandFailure(result),
          m(msg("The tracker refused it.")),
        ),
      });
      return;
    }
    onDone();
  };

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <Textarea
        autoFocus
        size="sm"
        aria-label={gt("Reply to {name}", { name })}
        placeholder={gt("Reply to {name}", { name })}
        value={body}
        disabled={posting}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Escape") onDone();
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void send();
          }
        }}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" disabled={posting} onClick={onDone}>
          <T>Cancel</T>
        </Button>
        <Button type="submit" size="sm" disabled={posting || body.trim().length === 0}>
          {posting ? <T>Posting…</T> : <T context="verb, posts the reply">Reply</T>}
        </Button>
      </div>
    </form>
  );
}
