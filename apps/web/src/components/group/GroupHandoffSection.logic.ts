export type HandoffBlock =
  | {
      readonly kind: "heading";
      readonly label: string;
      readonly warning: boolean;
      readonly key: number;
    }
  | { readonly kind: "text"; readonly text: string; readonly key: number }
  | { readonly kind: "list"; readonly items: ReadonlyArray<string>; readonly key: number };

const HEADINGS = [
  { pattern: "goal", label: "Goal", warning: false },
  { pattern: "current state", label: "Current state", warning: false },
  { pattern: "next steps", label: "Next steps", warning: false },
  { pattern: "don['’]t touch", label: "Don't touch", warning: true },
  { pattern: "must not touch", label: "Must not touch", warning: true },
] as const;

const HEADING_PATTERNS = HEADINGS.map((heading) => ({
  ...heading,
  exact: new RegExp(`^${heading.pattern}$`, "i"),
}));

// A heading stands alone or ends in a colon, so "Goal is to…" stays text.
const HEADING_LINE = new RegExp(
  `^\\s*(?:#{1,6}\\s+)?(?:\\*\\*|__)?(${HEADINGS.map((heading) => heading.pattern).join("|")})(?:\\*\\*|__)?\\s*(?::(?:\\*\\*|__)?\\s*(.*))?$`,
  "i",
);
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/;

/** Splits a handoff summary into labelled sections; only "Next steps" bullets become a list. */
export function parseHandoffSummary(summary: string): ReadonlyArray<HandoffBlock> {
  const blocks: Array<HandoffBlock> = [];
  let section: string | null = null;
  const lines = summary.split("\n");
  for (const [index, line] of lines.entries()) {
    // Keys step by two so a heading's inline text can take the odd key after it.
    const key = index * 2;
    const heading = HEADING_LINE.exec(line);
    const match =
      heading === null
        ? undefined
        : HEADING_PATTERNS.find((entry) => entry.exact.test(heading[1]!));
    if (heading !== null && match !== undefined) {
      section = match.label;
      blocks.push({ kind: "heading", label: match.label, warning: match.warning, key });
      const rest = heading[2]?.trim() ?? "";
      if (rest.length > 0) blocks.push({ kind: "text", text: rest, key: key + 1 });
      continue;
    }
    if (line.trim().length === 0) continue;
    const last = blocks.at(-1);
    const bullet = section === "Next steps" ? BULLET.exec(line) : null;
    if (bullet !== null) {
      if (last?.kind === "list") {
        blocks[blocks.length - 1] = { ...last, items: [...last.items, bullet[1]!] };
      } else {
        blocks.push({ kind: "list", items: [bullet[1]!], key });
      }
    } else if (last?.kind === "text") {
      blocks[blocks.length - 1] = { ...last, text: `${last.text}\n${line}` };
    } else {
      blocks.push({ kind: "text", text: line, key });
    }
  }
  return blocks;
}

/** More than three non-empty lines, or a paragraph too long for three lines of the panel. */
export function handoffNeedsCollapse(summary: string): boolean {
  return (
    summary.split("\n").filter((line) => line.trim().length > 0).length > 3 || summary.length > 240
  );
}
