import { describe, expect, it } from "vite-plus/test";

import { summarizeT3ToolCalls, type T3ToolSummaryCall } from "./t3ToolSummary.ts";

function completed(input: unknown, output?: unknown): T3ToolSummaryCall {
  return { input, output, outcome: "completed" };
}

describe("summarizeT3ToolCalls", () => {
  it("summarizes review list updates", () => {
    expect(summarizeT3ToolCalls("pr-review", [completed({}, {}), completed({}, {})]).label).toBe(
      "Updated the review list 2 times",
    );
    expect(
      summarizeT3ToolCalls("pr-review-read", [completed({}, {}), completed({}, {})]).label,
    ).toBe("Read the review list 2 times");
  });

  it("names the group and the chat a group tool started", () => {
    const group = { id: "group-1", title: "Auth refactor" };
    expect(
      summarizeT3ToolCalls("group-new-thread", [
        completed(
          { prompt: "Write auth tests" },
          { group, threadId: "t-2", title: "Write auth tests" },
        ),
      ]).label,
    ).toBe('Auth refactor → "Write auth tests"');
    expect(
      summarizeT3ToolCalls("group-handoff", [
        completed({ summary: "Done" }, { group, threadId: "t-3", title: "Continue: Plan" }),
      ]).label,
    ).toBe('Handed off to Auth refactor → "Continue: Plan"');
    expect(summarizeT3ToolCalls("group-read", [completed({}, { group })]).label).toBe(
      "Read group Auth refactor",
    );
    expect(
      summarizeT3ToolCalls("group-move-thread", [
        completed({ groupId: null }, { group: null, threadId: "t-1" }),
      ]).label,
    ).toBe("Took 1 chat out of its group");
    expect(
      summarizeT3ToolCalls("group-resource", [
        completed({ action: "add", name: "Dev server" }, { group, resources: [] }),
      ]).label,
    ).toBe("Added 1 resource to group Auth refactor");
  });

  it("reads provider result envelopes without treating JSON in the message as result data", () => {
    const result = { messageId: "message-1", threadId: "actual-thread" };
    const json = JSON.stringify(result);
    const outputs = [
      result,
      { structuredContent: result },
      [{ type: "text", text: json }],
      { content: [{ text: { text: json } }], isError: false },
      json,
    ];
    const calls = outputs.map((output) =>
      completed(
        {
          toolName: "t3_thread_send",
          args: { threadId: "input-thread", message: '{"threadId":"fake"}' },
        },
        output,
      ),
    );
    expect(summarizeT3ToolCalls("thread-send", calls).label).toBe("Sent 1 message to 1 thread");
    expect(
      summarizeT3ToolCalls("thread-send", [
        completed({ toolName: "t3_thread_send", args: { threadId: "input-thread" } }),
        completed({ threadId: "input-thread" }),
      ]).label,
    ).toBe("Sent 2 messages to 1 thread");
  });

  it("excludes failed and unfinished sends even if the provider reports completed", () => {
    const calls: T3ToolSummaryCall[] = [
      completed({ threadId: "success" }, { messageId: "ok", threadId: "success" }),
      completed(
        { threadId: "failed" },
        { isError: true, structuredContent: { threadId: "failed" } },
      ),
      completed({ threadId: "failed" }, [
        { type: "text", text: JSON.stringify({ _tag: "OrchestratorMcpFailure" }) },
      ]),
      { input: { threadId: "cancelled" }, output: undefined, outcome: "unfinished" },
    ];
    expect(summarizeT3ToolCalls("thread-send", calls)).toEqual({
      label: "Sent 1 message to 1 thread",
      failedCount: 2,
    });
    expect(summarizeT3ToolCalls("thread-send", [calls[1]!])).toEqual({
      label: "Tried to send 1 message to 1 thread",
      failedCount: 1,
    });
  });

  it("does not confuse a child's failure or wait timeout with failure of the orchestration call", () => {
    const failedChild = { taskId: "task-1", status: "failed", summary: "command not found" };
    expect(
      summarizeT3ToolCalls("delegate", [completed({}, failedChild), completed({}, failedChild)]),
    ).toEqual({
      label: "Delegated 1 task",
      failedCount: 0,
    });
    expect(
      summarizeT3ToolCalls(
        "task-status",
        Array.from({ length: 4 }, () => completed({ taskId: "task-1" }, failedChild)),
      ).label,
    ).toBe("Checked task status 4 times");
    expect(
      summarizeT3ToolCalls("thread-wait", [
        completed({ threadId: "thread-1" }, { threadId: "thread-1", timedOut: true }),
      ]),
    ).toEqual({
      label: "Waited on 1 thread",
      failedCount: 0,
    });
  });
});
