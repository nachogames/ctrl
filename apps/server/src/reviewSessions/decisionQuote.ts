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

/** Whether the sentence the quote sits in ends with a question mark. */
function endsInQuestion(message: string, quote: string): boolean {
  if (quote.endsWith("?")) return true;
  const rest = message.slice(message.indexOf(quote) + quote.length);
  return rest.match(/[.!?\n]/)?.[0] === "?";
}

/**
 * A decision stands only on the user's own words: `quote` must appear in their
 * latest message, must not sit in a question, and when that message names
 * points as `#N` it must name this one.
 */
export function checkDecisionQuote(input: {
  readonly latestUserMessage: string | null;
  readonly quote: string;
  readonly number: number;
}): DecisionQuoteRefusal | null {
  if (input.latestUserMessage === null) return "no-user-message";
  const quote = stripQuoteMarks(normalize(input.quote));
  if (quote.length < 2) return "quote-missing";
  const message = normalize(input.latestUserMessage);
  if (!message.includes(quote)) return "quote-not-in-message";
  if (endsInQuestion(message, quote)) return "quote-is-question";
  const named = [...message.matchAll(/#(\d+)\b/g)].map((match) => Number(match[1]));
  if (named.length > 0 && !named.includes(input.number)) return "message-names-other-items";
  return null;
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
      return `The user's latest message is about other points, not #${number}.`;
  }
}
