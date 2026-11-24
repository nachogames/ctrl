const TAG_PATTERN =
  /^About issue ([^\s():]{1,64})(?: \((https?:\/\/[^\s)]{1,2048})\)| in ([^\n:]{1,256}))?:\n/;

/**
 * A message sent about an issue: `About issue KEY (url):` on its own first line, then the
 * message. The agent reads the key and link; the timeline shows it as a tag above the bubble.
 */
export function formatIssueTag(
  issue: { readonly key: string; readonly url?: string | null; readonly scope?: string },
  text: string,
): string {
  const where = issue.url ? ` (${issue.url})` : issue.scope ? ` in ${issue.scope}` : "";
  return `About issue ${issue.key}${where}:\n${text}`;
}

/** The issue a message was sent about, or null when its first line is not an issue tag. */
export function parseIssueTag(
  text: string,
): { readonly key: string; readonly url: string | null; readonly body: string } | null {
  const match = TAG_PATTERN.exec(text);
  if (match === null) return null;
  return { key: match[1]!, url: match[2] ?? null, body: text.slice(match[0].length) };
}
