import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";

import { TOOL_HAND_OFF } from "./geminiProtocol.ts";

/** Threads listed in Shift's snapshot, newest first. */
export const SNAPSHOT_THREAD_LIMIT = 12;
/** Messages of a regular thread the front sees. */
export const RECENT_MESSAGE_LIMIT = 6;
const SNIPPET_LENGTH = 140;

export interface ThreadLine {
  readonly title: string;
  readonly state: string;
  readonly ago: string;
  readonly last: string | null;
}

export interface FrontContext {
  /** Shift's thread sees every thread; any other thread sees its own messages. */
  readonly kind: "shift" | "thread";
  readonly title: string;
  readonly threads: ReadonlyArray<ThreadLine>;
  readonly messages: ReadonlyArray<{ readonly role: "user" | "assistant"; readonly text: string }>;
}

const snippet = (text: string, length = SNIPPET_LENGTH) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
};

export function ago(fromMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.round((nowMs - fromMs) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** What a thread is doing, in the words the front speaks. */
export function threadState(shell: OrchestrationV2ThreadShell): string {
  if (shell.pendingRuntimeRequest)
    return shell.pendingRuntimeRequest.kind.includes("approval")
      ? "needs you: waiting for an approval"
      : "needs you: asked a question";
  if (shell.hasActionableProposedPlan) return "needs you: a plan is ready to review";
  switch (shell.activityRunStatus) {
    case "preparing":
    case "starting":
    case "running":
      return "working";
    case "waiting":
      return "waiting on background work";
  }
  switch (shell.status) {
    case "failed":
      return shell.lastError ? `failed: ${snippet(shell.lastError, 80)}` : "failed";
    case "interrupted":
    case "cancelled":
      return "stopped";
    case "queued":
      return "queued";
    default:
      return "done";
  }
}

export function threadLine(
  shell: OrchestrationV2ThreadShell,
  updatedAtMs: number,
  nowMs: number,
): ThreadLine {
  const last = shell.latestVisibleMessage;
  return {
    title: snippet(shell.title || "Untitled", 80),
    state: threadState(shell),
    ago: ago(updatedAtMs, nowMs),
    last: last && last.role === "assistant" && last.text.trim() ? snippet(last.text) : null,
  };
}

/** Who does the real work in this kind of thread. */
export const workerName = (kind: FrontContext["kind"]) =>
  kind === "shift" ? "Shift" : "the agent";

const handoffExample = (kind: FrontContext["kind"]) =>
  kind === "shift" ? "On it, I'll have Shift dig into that." : "Got it, the agent's on it.";

/** Rules every front voice follows, local or Gemini. */
function sharedRules(kind: FrontContext["kind"]): string {
  const worker = kind === "shift" ? "Shift" : "The agent";
  return `You are the voice of Ctrl, the app where the user runs coding agents in threads. You sound like a friendly coworker at the next desk who answers right away.

Rules:
- Reply in one or two short spoken sentences. Plain words only: no markdown, lists, code, emoji, or links.
- Only state facts that are in the context. Never invent threads, states, numbers, or results.
- You cannot do anything yourself, so never offer to. ${worker} does the work and reads the same message.`;
}

/** The instructions for one kind of thread. Exported for tests. */
export function systemPrompt(kind: FrontContext["kind"]): string {
  return `${sharedRules(kind)}
- Begin with exactly one tag.
- [answered]: you fully answer from the context. Use it for greetings, small talk, and questions about what threads are doing, what finished, or what needs the user; answer those yourself from the context.
- [handoff]: the user asks for work to be done (build, fix, change, check, research), a decision, or facts that are not in the context.
- After [handoff], say briefly that ${workerName(kind)} is on it, for example: "${handoffExample(kind)}"`;
}

/**
 * The Gemini front's instructions: the same rules, with tools in place of the
 * tags. Its context comes from check_threads, so it is never stale.
 */
export function geminiInstructions(kind: FrontContext["kind"]): string {
  const worker = workerName(kind);
  return `${sharedRules(kind)}
- The context is what check_threads returns. Call it before you answer anything about what threads are doing, what finished, or what needs the user.
- Answer greetings and small talk yourself, without tools.
- When the user asks for work to be done (build, fix, change, check, research), a decision, or facts check_threads does not give you, call ${TOOL_HAND_OFF}, then say briefly that ${worker} is on it, for example: "${handoffExample(kind)}"
- If the user starts talking, stop and listen.`;
}

export function contextText(context: FrontContext): string {
  const lines: string[] = [];
  if (context.kind === "shift") {
    lines.push(
      "This is Shift's thread. Shift is the agent that manages the user's other threads, and it gets this message too.",
    );
    lines.push(context.threads.length > 0 ? "Threads, newest first:" : "There are no threads.");
    for (const thread of context.threads)
      lines.push(
        `- "${thread.title}": ${thread.state}, updated ${thread.ago}${
          thread.last ? `. Last reply: "${thread.last}"` : ""
        }`,
      );
  } else {
    lines.push(
      `This is the thread "${context.title}". Its agent does the real work, and it gets this message too.`,
    );
    const thread = context.threads[0];
    if (thread) lines.push(`The thread is ${thread.state}, updated ${thread.ago}.`);
  }
  if (context.messages.length > 0) {
    lines.push("Latest messages in this thread:");
    for (const message of context.messages)
      lines.push(`${message.role === "user" ? "User" : "Agent"}: ${snippet(message.text, 300)}`);
  }
  return lines.join("\n");
}

export function chatMessages(context: FrontContext, transcript: string) {
  return [
    {
      role: "system" as const,
      content: `${systemPrompt(context.kind)}\n\nContext:\n${contextText(context)}`,
    },
    { role: "user" as const, content: transcript },
  ];
}

const TAGS = ["[answered]", "[handoff]"] as const;

/**
 * The spoken part of the model's output so far, and whether it answered.
 * Text before the tag is complete is held back, so the tag is never spoken.
 * Output without a tag counts as a handoff, which keeps the agent's reply read.
 */
export function parseFrontOutput(raw: string): {
  readonly text: string;
  readonly answered: boolean;
} {
  const trimmed = raw.trimStart();
  const lower = trimmed.toLowerCase();
  const tag = TAGS.find((candidate) => lower.startsWith(candidate));
  if (!tag && TAGS.some((candidate) => candidate.startsWith(lower)))
    return { text: "", answered: false };
  const body = tag ? trimmed.slice(tag.length) : trimmed;
  return { text: speakable(body), answered: tag === "[answered]" };
}

/** Drops markdown and stray tags a small model may still emit. */
export function speakable(text: string): string {
  return (
    text
      .replace(/\[(?:answered|handoff)\]/gi, "")
      .replace(/[*_`#>]+/g, "")
      .replace(/\s+/g, " ")
      // "[answered]: Hi" leaves its colon behind.
      .replace(/^[\s:;,.-]+/, "")
  );
}
