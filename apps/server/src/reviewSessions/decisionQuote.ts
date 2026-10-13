import { parseReviewPointTag } from "@t3tools/shared/reviewPointTag";

/** Why a quoted decision was refused. */
export type DecisionQuoteRefusal =
  | "no-user-message"
  | "quote-missing"
  | "quote-not-in-message"
  | "quote-is-question"
  | "message-names-other-items";

/** Case and runs of spaces do not matter; line breaks still end a sentence. */
const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .trim();

const stripQuoteMarks = (text: string) => text.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();

const TERMINATOR = /[.!?\n]/;

/** The distinct `#N` points a piece of text names. */
const namedPoints = (text: string) =>
  new Set([...text.matchAll(/#(\d+)\b/g)].map((match) => Number(match[1])));

/**
 * Judges one place the quote sits in the body. `start`..`end` is the quote; the
 * sentences it touches are what the user wrote about it.
 */
function checkOccurrence(
  body: string,
  start: number,
  end: number,
  number: number,
  tagNumber: number | null,
  multiPoint: boolean,
): DecisionQuoteRefusal | null {
  const quoteText = body.slice(start, end);
  const sentenceStart = body.slice(0, start).search(/[^.!?\n]*$/);
  const terminatorAfter = body.slice(end).search(TERMINATOR);
  const sentenceEnd = terminatorAfter === -1 ? body.length : end + terminatorAfter;
  if (quoteText.endsWith("?") || body[sentenceEnd] === "?") return "quote-is-question";
  if (!multiPoint) return null;
  const sentenceNames = namedPoints(body.slice(sentenceStart, sentenceEnd + 1));
  // A sentence that names no point is about the point the message was tagged with.
  if (sentenceNames.size === 0 && tagNumber !== null) sentenceNames.add(tagNumber);
  return sentenceNames.size === 1 && sentenceNames.has(number) ? null : "message-names-other-items";
}

/**
 * A decision stands only on the user's own words: `quote` must appear in their
 * latest message, outside a point tag (its label comes from the point, not the user),
 * must not sit in a question, and when the message names points as `#N` the
 * sentence holding the quote must name this one and no other.
 */
export function checkDecisionQuote(input: {
  readonly latestUserMessage: string | null;
  readonly quote: string;
  readonly number: number;
}): DecisionQuoteRefusal | null {
  if (input.latestUserMessage === null) return "no-user-message";
  const quote = stripQuoteMarks(normalize(input.quote));
  if (quote.length < 2) return "quote-missing";
  const tag = parseReviewPointTag(input.latestUserMessage);
  const body = normalize(tag === null ? input.latestUserMessage : tag.body);
  if (!body.includes(quote)) return "quote-not-in-message";
  const named = namedPoints(body);
  if (tag !== null) named.add(tag.number);
  if (named.size > 0 && !named.has(input.number)) return "message-names-other-items";
  // The same words can appear twice; any place that justifies the decision will do.
  let refusal: DecisionQuoteRefusal | null = null;
  for (let at = body.indexOf(quote); at !== -1; at = body.indexOf(quote, at + 1)) {
    const result = checkOccurrence(
      body,
      at,
      at + quote.length,
      input.number,
      tag?.number ?? null,
      named.size > 1,
    );
    if (result === null) return null;
    refusal ??= result;
  }
  return refusal;
}

/** What the agent is told; each one says what to do instead. */
export function decisionQuoteRefusalMessage(refusal: DecisionQuoteRefusal, number: number): string {
  switch (refusal) {
    case "no-user-message":
      return "The user has written nothing in this chat to quote. Ask for the decision, and record your view with review_items_annotate (suggestedDecision and recommendation).";
    case "quote-missing":
      return "Pass the user's own words as quote.";
    case "quote-not-in-message":
      return "The quote is not in the user's latest message. Only that message can decide a point; record your view with review_items_annotate.";
    case "quote-is-question":
      return "The user asked a question, and questions never change decisions. Answer it, and record your view with review_items_annotate.";
    case "message-names-other-items":
      return `The user's latest message is about other points, or names several. Quote only the part of it that mentions #${number}.`;
  }
}
