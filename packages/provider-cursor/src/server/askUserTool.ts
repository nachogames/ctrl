/**
 * The `ask_user` tool lets a Cursor agent ask the user a structured question.
 *
 * The Cursor Agent SDK declines its own clarifying-question tool in local
 * runs, so the adapter offers this host tool instead (`local.customTools`).
 * Its call becomes an ordinary `user_input` runtime request: the question card
 * in the chat, the waiting state in the sidebar, and the phone alert.
 *
 * @module askUserTool
 */
import type { SDKCustomToolResult, SDKJsonValue } from "@cursor/sdk";
import type {
  OrchestrationV2UserInputQuestion,
  ProviderUserInputAnswers,
} from "@t3tools/contracts";

export const ASK_USER_TOOL_NAME = "ask_user";
/** The MCP server the SDK exposes host tools under. */
export const CURSOR_CUSTOM_TOOLS_PROVIDER = "custom-user-tools";

export const ASK_USER_TOOL_DESCRIPTION =
  "Ask the user one or more questions and wait for their answers. Use it whenever you need " +
  "the user to decide or clarify something before you continue, instead of asking in your " +
  "reply and ending your turn. Give each question 2-4 short options; the user can also type " +
  "their own answer.";

export const ASK_USER_INPUT_SCHEMA: Record<string, SDKJsonValue> = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          question: { type: "string", description: "The full question to ask." },
          header: { type: "string", description: "A short label for the question, 1-3 words." },
          options: {
            type: "array",
            maxItems: 4,
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "The answer as the user would pick it." },
                description: { type: "string", description: "What choosing it means." },
              },
              required: ["label"],
            },
          },
          multiSelect: { type: "boolean", description: "Let the user pick more than one option." },
        },
        required: ["question"],
      },
    },
  },
  required: ["questions"],
};

export const ASK_USER_INSTRUCTIONS =
  `<asking_the_user>\nWhen you need the user to choose or clarify something before you can continue, ` +
  `call the \`${ASK_USER_TOOL_NAME}\` tool (MCP server \`${CURSOR_CUSTOM_TOOLS_PROVIDER}\`) and wait ` +
  `for its answer. Do not ask in your reply and end your turn instead.\n</asking_the_user>`;

const trimmedString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** Questions from the tool's arguments, in the shape the question card renders. */
export function askUserQuestions(args: unknown): ReadonlyArray<OrchestrationV2UserInputQuestion> {
  const questions =
    typeof args === "object" && args !== null ? Reflect.get(args, "questions") : undefined;
  if (!Array.isArray(questions)) return [];
  const seen = new Set<string>();
  return questions.flatMap((value: unknown, index: number) => {
    if (typeof value !== "object" || value === null) return [];
    const record = value as Record<string, unknown>;
    const question = trimmedString(record.question);
    if (question.length === 0) return [];
    // Answers come back keyed by id, so every question needs a distinct one.
    let id = question;
    for (let suffix = index + 1; seen.has(id); suffix++) id = `${question} (${suffix})`;
    seen.add(id);
    const header = trimmedString(record.header) || `Question ${index + 1}`;
    const options = Array.isArray(record.options)
      ? record.options.flatMap((option: unknown) => {
          if (typeof option !== "object" || option === null) return [];
          const optionRecord = option as Record<string, unknown>;
          const label = trimmedString(optionRecord.label);
          if (label.length === 0) return [];
          // The card requires a description; the label stands in when the model gives none.
          return [{ label, description: trimmedString(optionRecord.description) || label }];
        })
      : [];
    return [
      {
        id,
        header,
        question,
        options,
        multiSelect: record.multiSelect === true,
        allowCustomAnswer: true,
      },
    ];
  });
}

function answerText(answer: unknown): string {
  if (Array.isArray(answer)) {
    return answer.filter((value): value is string => typeof value === "string").join(", ");
  }
  return typeof answer === "string" ? answer : "";
}

/** The tool result the agent reads: one line per question, plus the answers as data. */
export function askUserResult(
  questions: ReadonlyArray<OrchestrationV2UserInputQuestion>,
  answers: ProviderUserInputAnswers,
): SDKCustomToolResult {
  // Keyed by id, which is the question text unless two questions share it.
  const byQuestion: Record<string, string> = {};
  for (const question of questions) {
    byQuestion[question.id] = answerText(answers[question.id]);
  }
  const text = questions
    .map((question) => {
      const answer = byQuestion[question.id];
      return `${question.question}\nAnswer: ${answer === "" ? "(no answer)" : answer}`;
    })
    .join("\n\n");
  return {
    content: [{ type: "text", text }],
    structuredContent: { answers: byQuestion },
  };
}

export function askUserError(text: string): SDKCustomToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export function isAskUserToolCall(toolCall: {
  readonly type: string;
  readonly args?: unknown;
}): boolean {
  if (toolCall.type !== "mcp" || typeof toolCall.args !== "object" || toolCall.args === null) {
    return false;
  }
  return (
    Reflect.get(toolCall.args, "providerIdentifier") === CURSOR_CUSTOM_TOOLS_PROVIDER &&
    Reflect.get(toolCall.args, "toolName") === ASK_USER_TOOL_NAME
  );
}

/** A streamed MCP call whose server or tool name has not arrived yet. */
export function isUnnamedMcpToolCall(toolCall: {
  readonly type: string;
  readonly args?: unknown;
}): boolean {
  if (toolCall.type !== "mcp") return false;
  const args = typeof toolCall.args === "object" && toolCall.args !== null ? toolCall.args : {};
  return (
    typeof Reflect.get(args, "providerIdentifier") !== "string" ||
    typeof Reflect.get(args, "toolName") !== "string"
  );
}
