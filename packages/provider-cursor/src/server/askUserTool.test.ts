import { assert, describe, it } from "@effect/vitest";

import {
  askUserQuestions,
  askUserResult,
  isAskUserToolCall,
  isUnnamedMcpToolCall,
} from "./askUserTool.ts";

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

  it("keeps the answers to two identical questions apart", () => {
    const questions = askUserQuestions({
      questions: [{ question: "Which file?" }, { question: "Which file?" }],
    });
    assert.deepEqual(
      askUserResult(questions, { "Which file?": "a.ts", "Which file? (2)": "b.ts" }),
      {
        content: [{ type: "text", text: "Which file?\nAnswer: a.ts\n\nWhich file?\nAnswer: b.ts" }],
        structuredContent: { answers: { "Which file?": "a.ts", "Which file? (2)": "b.ts" } },
      },
    );
  });

  it("never gives two questions the same id", () => {
    const ids = askUserQuestions({
      questions: [{ question: "A (3)" }, { question: "A" }, { question: "A" }],
    }).map((question) => question.id);
    assert.deepEqual(ids, ["A (3)", "A", "A (4)"]);
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

  it("spots an MCP call that has not named its tool yet", () => {
    assert.isTrue(isUnnamedMcpToolCall({ type: "mcp", args: {} }));
    assert.isTrue(isUnnamedMcpToolCall({ type: "mcp", args: { providerIdentifier: "x" } }));
    assert.isFalse(
      isUnnamedMcpToolCall({ type: "mcp", args: { providerIdentifier: "x", toolName: "y" } }),
    );
    assert.isFalse(isUnnamedMcpToolCall({ type: "shell", args: {} }));
  });
});
