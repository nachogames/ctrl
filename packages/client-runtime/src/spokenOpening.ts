/**
 * The part of an assistant message that is read aloud: its opening paragraph,
 * cut to a couple of plain sentences. Works on streaming text, so the first
 * sentence can be spoken as soon as it is complete.
 */

export const SPOKEN_OPENING_MAX_SENTENCES = 2;
export const SPOKEN_OPENING_MAX_CHARS = 300;

export interface SpokenOpening {
  /** Sentences ready to speak, in order. Later calls on longer text only append. */
  readonly sentences: ReadonlyArray<string>;
  /** True once no more sentences will be added. */
  readonly complete: boolean;
}

/** Lines that start something other than prose: headings, lists, code, tables, quotes. */
const BLOCK_START = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|```|~~~|\||>)/;
const ABBREVIATIONS = new Set(["e.g", "i.e", "vs", "etc", "mr", "mrs", "ms", "dr", "approx"]);

/** The opening paragraph and whether it has ended. */
function openingBlock(text: string, streaming: boolean): { block: string; ended: boolean } {
  const source = text.replace(/^\s+/, "");
  const lines = source.split("\n");
  if (BLOCK_START.test(lines[0] ?? "")) return { block: "", ended: true };
  const kept: string[] = [lines[0] ?? ""];
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]!;
    // The newest line may still be arriving, so it cannot end the paragraph yet.
    const settled = !streaming || index < lines.length - 1;
    if (settled && (line.trim() === "" || BLOCK_START.test(line)))
      return { block: kept.join(" "), ended: true };
    if (!settled && BLOCK_START.test(line)) return { block: kept.join(" "), ended: true };
    kept.push(line);
  }
  return { block: kept.join(" "), ended: !streaming };
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
  const cut = sentence.slice(0, SPOKEN_OPENING_MAX_CHARS + 1);
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : cut.slice(0, SPOKEN_OPENING_MAX_CHARS)).replace(
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
  const { block, ended } = openingBlock(markdown, streaming);
  const source = ended ? block : closedPrefix(block);
  // Trailing whitespace is what marks a streamed sentence as finished.
  const text = plainSpokenText(source) + (/\s$/.test(source) ? " " : "");
  const split = splitSentences(text);
  const candidates = ended && split.rest ? [...split.sentences, split.rest] : split.sentences;
  const sentences: string[] = [];
  let length = 0;
  for (const candidate of candidates) {
    if (!/[\p{L}\p{N}]/u.test(candidate)) continue;
    if (sentences.length === SPOKEN_OPENING_MAX_SENTENCES) return { sentences, complete: true };
    if (length + candidate.length > SPOKEN_OPENING_MAX_CHARS) {
      if (sentences.length === 0) sentences.push(truncate(candidate));
      return { sentences, complete: true };
    }
    sentences.push(candidate);
    length += candidate.length + 1;
  }
  if (sentences.length === SPOKEN_OPENING_MAX_SENTENCES) return { sentences, complete: true };
  // An unfinished first sentence that is already over the cap will not get shorter.
  if (!ended && sentences.length === 0 && split.rest.length > SPOKEN_OPENING_MAX_CHARS)
    return { sentences: [truncate(split.rest)], complete: true };
  return { sentences, complete: ended };
}
