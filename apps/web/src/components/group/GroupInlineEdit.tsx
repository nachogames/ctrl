import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { cn } from "~/lib/utils";

/** Enter (or blur) saves, Escape cancels; mounted only while editing. */
export function GroupInlineEdit(props: {
  label: string;
  initial: string;
  placeholder?: string;
  className: string;
  onCommit: (draft: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(props.initial);
  const doneRef = useRef(false);
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      doneRef.current = true;
      props.onCommit(draft);
    } else if (event.key === "Escape") {
      event.preventDefault();
      doneRef.current = true;
      props.onCancel();
    }
  };
  return (
    <input
      autoFocus
      value={draft}
      aria-label={props.label}
      placeholder={props.placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={handleKeyDown}
      onBlur={() => {
        if (!doneRef.current) props.onCommit(draft);
      }}
      className={cn(
        "min-w-0 flex-1 rounded-sm border border-input bg-card px-1 text-card-foreground outline-none focus:border-foreground",
        props.className,
      )}
    />
  );
}
