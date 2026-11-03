/**
 * The part of an assistant message that is read aloud: its prose, paragraph by
 * paragraph, with list items and headings as sentences and code and tables
 * left out, capped so a long reply does not talk for minutes. Works on
 * streaming text, so the first sentence can be spoken as soon as it is complete.
 */

export const SPOKEN_REPLY_MAX_SENTENCES = 12;
export const SPOKEN_REPLY_MAX_CHARS = 1200;

export interface SpokenOpening {
  /** Sentences ready to speak, in order. Later calls on longer text only append. */
  readonly sentences: ReadonlyArray<string>;
  /** True once no more sentences will be added. */
  readonly complete: boolean;
}

const FENCE = /^\s*(```|~~~)/;
const TABLE_ROW = /^\s*\|/;
/** Heading, list and quote markers, which are not spoken. */
const LINE_MARKER = /^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/;
const ENDS_SENTENCE = /[.!?:]["')\u201d\u2019]*$/;
const ABBREVIATIONS = new Set(["e.g", "i.e", "vs", "etc", "mr", "mrs", "ms", "dr", "approx"]);

/**
 * The reply's prose as one run of text. Each finished line ends as a sentence,
 * so paragraphs and list items are read as separate sentences. While streaming,
 * the newest line may still be arriving and is kept as an open tail.
 */
function spokenProse(text: string, streaming: boolean): { settled: string; tail: string } {
  const lines = text.split("\n");
  let inFence = false;
  let settled = "";
  let tail = "";
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const arriving = streaming && index === lines.length - 1;
    if (FENCE.test(line)) {
      if (!arriving) inFence = !inFence;
      continue;
    }
    if (inFence || TABLE_ROW.test(line)) continue;
    const words = line.replace(LINE_MARKER, "").trim();
    if (words === "") continue;
    if (arriving) {
      // Keeps trailing whitespace: it is what marks the tail's last sentence as finished.
      tail = line.replace(LINE_MARKER, "").trimStart();
      continue;
    }
    settled += `${ENDS_SENTENCE.test(words) ? words : `${words}.`} `;
  }
  return { settled, tail };
}

/** Cuts streaming text before a link, code span or tag that has not closed yet. */
function closedPrefix(block: string): string {
  for (let index = 0; index < block.length; index++) {
    const char = block[index];
    if (char === "`") {
      const close = block.indexOf("`", index + 1);
      if (close === -1) return block.slice(0, index);
      index = close;
    } else if (char === "[") {
      const close = block.indexOf("]", index + 1);
      if (close === -1) return block.slice(0, index);
      if (close === block.length - 1) return block.slice(0, index);
      if (block[close + 1] === "(") {
        const end = block.indexOf(")", close + 2);
        if (end === -1) return block.slice(0, index);
        index = end;
      }
    } else if (char === "<") {
      if (block.indexOf(">", index + 1) === -1) return block.slice(0, index);
    }
  }
  return block;
}

/** Markdown to plain words: links keep their text, URLs, images and long code drop out. */
export function plainSpokenText(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<https?:\/\/[^>]*>/g, "")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/\bhttps?:\/\/\S+/g, "")
    .replace(/`([^`]*)`/g, (_, code: string) => (code.length <= 30 ? code : ""))
    .replace(/~~/g, "")
    .replace(/\*+/g, "")
    .replace(/(^|\s)_{1,2}(\S[^_]*?)_{1,2}(?=[\s.,!?;:]|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();
}

/** Splits at sentence ends followed by whitespace; the tail is returned separately. */
function splitSentences(text: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (!".!?".includes(text[index]!)) continue;
    let end = index + 1;
    while (end < text.length && ".!?\"')”’".includes(text[end]!)) end++;
    if (end >= text.length || !/\s/.test(text[end]!)) {
      index = end - 1;
      continue;
    }
    const sentence = text.slice(start, end).trim();
    const lastWord = sentence
      .slice(0, sentence.length - (end - index))
      .split(" ")
      .at(-1)
      ?.toLowerCase();
    if (text[index] === "." && lastWord && ABBREVIATIONS.has(lastWord)) continue;
    if (sentence) sentences.push(sentence);
    start = end;
    index = end - 1;
  }
  return { sentences, rest: text.slice(start).trim() };
}

/** A sentence over the cap ends at its last whole word within it. */
function truncate(sentence: string): string {
  const cut = sentence.slice(0, SPOKEN_REPLY_MAX_CHARS + 1);
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : cut.slice(0, SPOKEN_REPLY_MAX_CHARS)).replace(
    /[,;:\s]+$/,
    "",
  );
}

/**
 * The sentences to read aloud from an assistant message. `streaming` is true
 * while the message may still grow: only sentences already followed by more
 * text count then, so each returned sentence is final.
 */
export function spokenOpening(markdown: string, streaming: boolean): SpokenOpening {
  const prose = spokenProse(markdown, streaming);
  const tail = closedPrefix(prose.tail);
  // Trailing whitespace is what marks a streamed sentence as finished.
  const text = `${plainSpokenText(prose.settled)} ${plainSpokenText(tail)}${
    tail.length < prose.tail.length || /\s$/.test(tail) ? " " : ""
  }`.replace(/^\s+/, "");
  const split = splitSentences(prose.tail === "" ? `${text.trimEnd()} ` : text);
  const ended = !streaming;
  const candidates = ended && split.rest ? [...split.sentences, split.rest] : split.sentences;
  const sentences: string[] = [];
  let length = 0;
  for (const candidate of candidates) {
    if (!/[\p{L}\p{N}]/u.test(candidate)) continue;
    if (sentences.length === SPOKEN_REPLY_MAX_SENTENCES) return { sentences, complete: true };
    if (length + candidate.length > SPOKEN_REPLY_MAX_CHARS) {
      if (sentences.length === 0) sentences.push(truncate(candidate));
      return { sentences, complete: true };
    }
    sentences.push(candidate);
    length += candidate.length + 1;
  }
  if (sentences.length === SPOKEN_REPLY_MAX_SENTENCES) return { sentences, complete: true };
  // An unfinished first sentence that is already over the cap will not get shorter.
  if (!ended && sentences.length === 0 && split.rest.length > SPOKEN_REPLY_MAX_CHARS)
    return { sentences: [truncate(split.rest)], complete: true };
  return { sentences, complete: ended };
}
