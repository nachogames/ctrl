/** Longest label a point tag carries; the chip and the tag stay one short line. */
export const REVIEW_POINT_LABEL_MAX = 40;

const TAG_PATTERN = /^\[#(\d{1,5}) ([^\]\n]{1,40})\]\n/;

// The label comes from review comments, not the user. A `$name` token in it would read as a
// skill mention (any currency sigil after a space starts one) and could make the provider run a
// skill the user never asked for, so a sigil that opens a word is dropped.
const cleanLabel = (label: string) =>
  label
    .replace(/[\]\n\r]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/(^| )\p{Sc}+/gu, "$1")
    .trim()
    .slice(0, REVIEW_POINT_LABEL_MAX)
    .trim();

/**
 * A message sent with a review point attached: `[#N label]` on its own first line, then
 * the message. The agent reads it as "this is about #N"; the quote guard sees `#N`; the
 * timeline shows it as a tag above the bubble.
 */
export function formatReviewPointTag(
  point: { readonly number: number; readonly label: string },
  text: string,
): string {
  return `[#${point.number} ${cleanLabel(point.label) || "point"}]\n${text}`;
}

/** The point a message was sent about, or null when its first line is not a tag. */
export function parseReviewPointTag(
  text: string,
): { readonly number: number; readonly label: string; readonly body: string } | null {
  const match = TAG_PATTERN.exec(text);
  if (match === null) return null;
  return { number: Number(match[1]), label: match[2]!, body: text.slice(match[0].length) };
}
