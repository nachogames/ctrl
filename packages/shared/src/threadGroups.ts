import { isLoopbackHost } from "./preview.ts";

/** Label for a link on a chat group: a Linear key, `#N` for a GitHub issue or pull request, else the host. Null when it is not an http(s) URL. */
export function groupLinkLabel(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  if (url.hostname === "linear.app" || url.hostname.endsWith(".linear.app")) {
    const issueIndex = segments.indexOf("issue");
    const key = issueIndex === -1 ? undefined : segments[issueIndex + 1];
    if (key !== undefined && /^[a-z][a-z0-9]*-\d+$/i.test(key)) {
      return key.toUpperCase();
    }
  }
  const [, , kind, number] = segments;
  if ((kind === "issues" || kind === "pull") && number !== undefined && /^\d+$/.test(number)) {
    return `#${number}`;
  }
  return url.hostname;
}

/** `#N` references in a pull request title, linked to issues in its repository. */
export function pullRequestTitleIssueLinks(input: {
  readonly title: string;
  readonly host: string;
  readonly repository: string;
  readonly number: number;
}): ReadonlyArray<{ readonly url: string; readonly label: string }> {
  const seen = new Set<number>([input.number]);
  const links: Array<{ url: string; label: string }> = [];
  for (const match of input.title.matchAll(/(?<![\w/#])#(\d+)\b/g)) {
    const number = Number.parseInt(match[1]!, 10);
    if (seen.has(number)) continue;
    seen.add(number);
    links.push({
      label: `#${number}`,
      url: `https://${input.host}/${input.repository}/issues/${number}`,
    });
  }
  return links;
}

/** The loopback port a URL points at, or null when it points elsewhere or is not a URL. */
export function loopbackPort(raw: string): number | null {
  try {
    const url = new URL(raw);
    if (!isLoopbackHost(url.hostname) && url.hostname !== "0.0.0.0") return null;
    if (url.port.length > 0) return Number.parseInt(url.port, 10);
    return url.protocol === "http:" ? 80 : url.protocol === "https:" ? 443 : null;
  } catch {
    return null;
  }
}
