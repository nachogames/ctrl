import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const THREAD_LINK_PROTOCOL = "t3-thread";
const THREAD_LINK_HREF_PREFIX = `${THREAD_LINK_PROTOCOL}://v1/`;
// Home links threads in other environments; the environment rides in this suffix.
const THREAD_LINK_ENVIRONMENT_SUFFIX = /\?environment=([^&?#]+)$/;
// Code comes first in the alternation so a link written inside a code span or fence is skipped.
const THREAD_LINK_OUTSIDE_CODE =
  /(?<fence>(`{3,}|~{3,})[\s\S]*?(?:\2|$))|(?<span>(`+)[^\n]*?\4)|\[[^\]\n]*\]\((?<href>t3-thread:\/\/v1\/[^\s)]+)\)/g;

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

/**
 * The thread a link names, and the environment it lives in when the link says
 * so. A null environment means the environment of the message holding the link.
 */
export function parseThreadLinkTarget(
  href: string,
): { readonly environmentId: EnvironmentId | null; readonly threadId: ThreadId } | null {
  if (!href.startsWith(THREAD_LINK_HREF_PREFIX)) return null;
  const rest = href.slice(THREAD_LINK_HREF_PREFIX.length);
  const suffix = THREAD_LINK_ENVIRONMENT_SUFFIX.exec(rest);
  if (suffix === null) {
    const threadId = Option.getOrNull(decodeThreadId(rest));
    return threadId === null ? null : { environmentId: null, threadId };
  }
  let environment: string;
  try {
    environment = decodeURIComponent(suffix[1]!);
  } catch {
    return null;
  }
  const environmentId = Option.getOrNull(decodeEnvironmentId(environment));
  const threadId = Option.getOrNull(decodeThreadId(rest.slice(0, suffix.index)));
  return environmentId === null || threadId === null ? null : { environmentId, threadId };
}

/** The id as written. Thread ids can hold percent escapes of their own, so it is not decoded. */
export function parseThreadLinkHref(href: string): ThreadId | null {
  return parseThreadLinkTarget(href)?.threadId ?? null;
}

export function percentDecodedThreadLinkId(threadId: ThreadId): ThreadId | null {
  try {
    const decoded = decodeURIComponent(threadId);
    return decoded === threadId ? null : Option.getOrNull(decodeThreadId(decoded));
  } catch {
    return null;
  }
}

function threadLinkLabel(label: string): string {
  return label
    .replace(/[[\]\\\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatThreadLink(threadId: string, label: string): string {
  return `[${threadLinkLabel(label) || threadId}](${THREAD_LINK_HREF_PREFIX}${threadId})`;
}

/** A link that opens the thread in the named environment, wherever the message holding it lives. */
export function formatEnvironmentThreadLink(thread: {
  readonly environmentId: string;
  readonly threadId: string;
  readonly title: string;
}): string {
  const href = `${THREAD_LINK_HREF_PREFIX}${thread.threadId}?environment=${encodeURIComponent(thread.environmentId)}`;
  return `[${threadLinkLabel(thread.title) || thread.threadId}](${href})`;
}

export function hasThreadLinks(markdown: string): boolean {
  return markdown.includes(`](${THREAD_LINK_HREF_PREFIX}`);
}

/**
 * Relabels links with the current title. `title` sees the link's environment,
 * null when the link names none.
 */
export function relabelThreadLinks(
  markdown: string,
  title: (threadId: ThreadId, environmentId: EnvironmentId | null) => string | undefined,
): string {
  if (!hasThreadLinks(markdown)) return markdown;
  return markdown.replace(THREAD_LINK_OUTSIDE_CODE, (source, ...args) => {
    const href = (args.at(-1) as { href?: string }).href;
    if (href === undefined) return source;
    const target = parseThreadLinkTarget(href);
    if (target === null) return source;
    const { environmentId, threadId: written } = target;
    const decoded = percentDecodedThreadLinkId(written);
    const threadId =
      title(written, environmentId) === undefined &&
      decoded !== null &&
      title(decoded, environmentId) !== undefined
        ? decoded
        : written;
    const label = title(threadId, environmentId)?.trim();
    if (!label) return source;
    return environmentId === null
      ? formatThreadLink(threadId, label)
      : formatEnvironmentThreadLink({ environmentId, threadId, title: label });
  });
}
