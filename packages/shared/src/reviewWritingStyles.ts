import type { ReviewWritingStyleSettings } from "@t3tools/contracts";

export interface ReviewWritingStyle {
  /** A built-in id, or a custom style's name. */
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** What the agent is sent: `rules`, plus the example for a built-in style. */
  readonly instructions: string;
  /** How findings read in this style, as the user would describe it. */
  readonly rules: string;
  /** A sample finding in this style; null for the user's own styles. */
  readonly example: string | null;
  readonly builtIn: boolean;
}

export const DEFAULT_REVIEW_WRITING_STYLE = "outcome";
export const MAX_CUSTOM_REVIEW_STYLES = 20;
export const MAX_REVIEW_STYLE_NAME_LENGTH = 40;
export const MAX_REVIEW_STYLE_INSTRUCTIONS_LENGTH = 8000;

/** `base`, or `base 2`, `base 3`… when a style already has that name. */
function freeReviewStyleName(base: string, taken: ReadonlyArray<string>): string {
  const trimmed = base.trim().slice(0, MAX_REVIEW_STYLE_NAME_LENGTH);
  if (!taken.includes(trimmed)) return trimmed;
  for (let index = 2; ; index++) {
    const suffix = ` ${index}`;
    const name = `${trimmed.slice(0, MAX_REVIEW_STYLE_NAME_LENGTH - suffix.length)}${suffix}`;
    if (!taken.includes(name)) return name;
  }
}

// One finding in each built-in style, so the Review tab can show the difference side by side.
const OUTCOME_EXAMPLE = `**What breaks:** When the Copy Link test fails, the card-menu test fails too, so one bug shows up as two failures.

**Why:** The test replaces \`navigator\` and only restores it on its last line, which a failed check skips.

**Fix:** Stub only \`clipboard.writeText\` and restore it in \`afterEach\`, as \`AdminAppShell.spec.ts\` does. The copied address and the "Link copied" toast checks stay as they are.`;

const OUTCOME = `Write the writeup as three labeled paragraphs, with a blank line between them:

**What breaks:** one sentence naming the visible failure and when it happens. Say what the user, test or caller sees, not the code path.

**Why:** one to three sentences on the cause, pointing at the exact line or call.

**Fix:** the change. Use a numbered list when it takes more than one step. End with the behavior that must keep working.

Lead with the result. Do not retell the code in execution order. Keep sentences short and concrete, and put code identifiers in backticks.`;

const SKIMMABLE_EXAMPLE = `**What breaks:** If the Copy Link test fails, the card-menu test fails too.

**Why:** The real \`navigator\` is only restored on the test's last line, which a failed check skips.

**Fix:**

1. Stub only \`clipboard.writeText\` instead of all of \`navigator\`.
2. Restore it in \`afterEach\`, like **\`AdminAppShell.spec.ts\`** does.`;

// Adapted from the MIT-licensed i-have-adhd skill (github.com/ayghri/i-have-adhd).
const SKIMMABLE = `The reader has ADHD. Working memory is small and starting is the hardest step. Shape the writeup so it can be acted on at a glance. Put a blank line between its parts.

1. First line: **What breaks:** in plain words, one sentence. Nothing before it.
2. **Why:** at most two sentences.
3. **Fix:** a numbered list. One bounded action per step, five steps at most. Fold trivial steps into the step before. A step never contains "and then" twice.

- Bold only the one file, function or value that matters most.
- Matter-of-fact tone. No preamble, no recap, no "it's worth noting", no idioms ("circle back", "on the same page").
- Delete hedging adverbs that add nothing ("perhaps", "could possibly"). Keep a hedge that carries real uncertainty: deleting it states a guess as a fact.

Check before saving: the first line says what is wrong, and the Fix steps say what to do, without reading anything else.`;

const PLAIN_EXAMPLE = `The card-menu test fails when the Copy Link test fails.

**Cause:** The Copy Link test replaces \`navigator\`. The test restores \`navigator\` only on its last line. A failed check stops the test before that line.

**Fix:**

1. Replace only \`clipboard.writeText\`.
2. Restore \`clipboard.writeText\` in \`afterEach\`, as \`AdminAppShell.spec.ts\` does.
3. Keep the address check and the toast check.`;

// Inspired by ASD-STE100 Simplified Technical English; not a certified STE rewrite.
const PLAIN = `Write the writeup in Simplified Technical English style.

- Start with one sentence that states what fails and when.
- Then two short paragraphs labeled **Cause:** and **Fix:**, with a blank line before each. Use a numbered list for three or more fix steps.
- Use active voice. Write one idea per sentence. Keep each sentence to 20 words or fewer.
- Use simple tenses: "the test fails", not "the test has been failing".
- Do not use phrasal verbs ("set up", "take out"), semicolons, or noun stacks of four or more words.
- Use one name for each thing, and use that name every time.
- Use verbs, not nouns made from verbs: "check the value", not "perform a check of the value".
- Keep every hedge ("may", "can"). Do not state a guess as a fact.
- Put code identifiers in backticks.`;

const preset = (
  style: Omit<ReviewWritingStyle, "builtIn" | "instructions">,
): ReviewWritingStyle => ({
  id: style.id,
  label: style.label,
  description: style.description,
  example: style.example,
  rules: style.rules,
  instructions: `${style.rules}\n\nExample:\n\n${style.example}`,
  builtIn: true,
});

export const REVIEW_WRITING_STYLE_PRESETS: ReadonlyArray<ReviewWritingStyle> = [
  preset({
    id: "outcome",
    label: "Outcome first",
    description: "What breaks, why, and the fix, in three short paragraphs.",
    rules: OUTCOME,
    example: OUTCOME_EXAMPLE,
  }),
  preset({
    id: "skimmable",
    label: "Skimmable",
    description: "Built for ADHD readers: the failure first, then numbered fix steps.",
    rules: SKIMMABLE,
    example: SKIMMABLE_EXAMPLE,
  }),
  preset({
    id: "plain",
    label: "Plain technical",
    description:
      "Short active sentences, one idea each, in the style of Simplified Technical English.",
    rules: PLAIN,
    example: PLAIN_EXAMPLE,
  }),
];

/** Built-in styles first, then the user's own; a custom style named like a built-in id is hidden. */
export function reviewWritingStyles(
  setting: Pick<ReviewWritingStyleSettings, "custom">,
): ReadonlyArray<ReviewWritingStyle> {
  const builtInIds = new Set(REVIEW_WRITING_STYLE_PRESETS.map((style) => style.id));
  return [
    ...REVIEW_WRITING_STYLE_PRESETS,
    ...setting.custom
      .filter((style) => !builtInIds.has(style.name))
      .map((style) => ({
        id: style.name,
        label: style.name,
        description: "Your own style.",
        instructions: style.instructions,
        rules: style.instructions,
        example: null,
        builtIn: false,
      })),
  ];
}

/** The style named `id`, else the selected one, else the default. */
export function resolveReviewWritingStyle(
  setting: ReviewWritingStyleSettings,
  id: string = setting.selected,
): ReviewWritingStyle {
  const styles = reviewWritingStyles(setting);
  return (
    styles.find((style) => style.id === id) ??
    styles.find((style) => style.id === setting.selected) ??
    REVIEW_WRITING_STYLE_PRESETS[0]!
  );
}

/** A style being written: a new one (`editing` null) or the user's style named `editing`. */
export interface ReviewStyleDraft {
  readonly editing: string | null;
  readonly name: string;
  readonly instructions: string;
}

/**
 * The setting after saving `draft`. A new style gets a free name and becomes the selected one;
 * an edit keeps its name when the new one is blank or taken, and stays selected if it was.
 */
export function saveReviewStyleDraft(
  setting: ReviewWritingStyleSettings,
  draft: ReviewStyleDraft,
): ReviewWritingStyleSettings {
  const ids = reviewWritingStyles(setting).map((style) => style.id);
  const instructions = draft.instructions.trim();
  if (draft.editing === null) {
    const name = freeReviewStyleName(draft.name, ids);
    return { selected: name, custom: [...setting.custom, { name, instructions }] };
  }
  const editing = draft.editing;
  const wanted = draft.name.trim().slice(0, MAX_REVIEW_STYLE_NAME_LENGTH);
  const name =
    wanted === "" || ids.some((id) => id !== editing && id === wanted) ? editing : wanted;
  return {
    selected: setting.selected === editing ? name : setting.selected,
    custom: setting.custom.map((style) =>
      style.name === editing ? { name, instructions } : style,
    ),
  };
}

/** The setting without the user's style `name`; deleting the selected one selects the default. */
export function deleteReviewStyle(
  setting: ReviewWritingStyleSettings,
  name: string,
): ReviewWritingStyleSettings {
  return {
    selected: setting.selected === name ? DEFAULT_REVIEW_WRITING_STYLE : setting.selected,
    custom: setting.custom.filter((style) => style.name !== name),
  };
}
