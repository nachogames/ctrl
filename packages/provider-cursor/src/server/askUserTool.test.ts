import { assert, describe, it } from "@effect/vitest";

import { askUserQuestions, askUserResult, isAskUserToolCall } from "./askUserTool.ts";

describe("askUserTool", () => {
  it("normalizes questions for the question card", () => {
    const questions = askUserQuestions({
      questions: [
        {
          question: " Which database? ",
          header: "Database",
          options: [{ label: "Postgres", description: "Relational" }, { label: "SQLite" }, {}],
          multiSelect: true,
        },
        { question: "" },
        { question: "Which database? " },
        "not a question",
      ],
    });
    assert.deepEqual(questions, [
      {
        id: "Which database?",
        header: "Database",
        question: "Which database?",
        options: [
          { label: "Postgres", description: "Relational" },
          { label: "SQLite", description: "SQLite" },
        ],
        multiSelect: true,
        allowCustomAnswer: true,
      },
      {
        id: "Which database? (3)",
        header: "Question 3",
        question: "Which database?",
        options: [],
        multiSelect: false,
        allowCustomAnswer: true,
      },
    ]);
    assert.deepEqual(askUserQuestions({}), []);
    assert.deepEqual(askUserQuestions(null), []);
  });

  it("returns one answer line per question", () => {
    const questions = askUserQuestions({
      questions: [{ question: "Pick colors", multiSelect: true }, { question: "Why?" }],
    });
    assert.deepEqual(askUserResult(questions, { "Pick colors": ["Red", "Blue"] }), {
      content: [
        { type: "text", text: "Pick colors\nAnswer: Red, Blue\n\nWhy?\nAnswer: (no answer)" },
      ],
      structuredContent: { answers: { "Pick colors": "Red, Blue", "Why?": "" } },
    });
  });

  it("recognizes its own MCP tool calls", () => {
    assert.isTrue(
      isAskUserToolCall({
        type: "mcp",
        args: { providerIdentifier: "custom-user-tools", toolName: "ask_user" },
      }),
    );
    assert.isFalse(
      isAskUserToolCall({
        type: "mcp",
        args: { providerIdentifier: "github", toolName: "ask_user" },
      }),
    );
    assert.isFalse(isAskUserToolCall({ type: "shell", args: {} }));
  });
});
