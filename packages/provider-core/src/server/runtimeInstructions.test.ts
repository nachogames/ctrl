import { assert, describe, it } from "@effect/vitest";

import { buildRuntimeInstructions } from "./runtimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it.each(["Codex", "Claude Code", "Cursor", "OpenCode", "Grok", "Antigravity", "Muse"])(
    "routes PR reviews through persistent sessions for %s without project skills",
    (harness) => {
      const instructions = buildRuntimeInstructions({ harness });
      assert.include(instructions, "with no review-pr skill");
      assert.include(instructions, "gh pr view --json url,headRefOid,state (skip a closed PR)");
      // Only here does a review's link beat the linking block's "skip PRs you only review".
      assert.include(instructions, "link it with link_pull_request: a review links its PR");
      assert.include(instructions, "call t3_group_create with no arguments");
      assert.include(instructions, "call review_session_open and follow the brief it returns");
      assert.include(instructions, "keeps to that role");
      assert.include(instructions, "If the review tools are unavailable");
      // The loop's rules live in the brief review_session_open returns (reviewBrief.ts).
      assert.notInclude(instructions, "Questions do not change decisions");
      assert.notInclude(instructions, "review_items_import");
    },
  );

  it("leaves PR linking to a session that already carries it, and keeps runtime identity", () => {
    const instructions = buildRuntimeInstructions({
      harness: "Antigravity",
      model: "gemini-3.8-flash",
      pullRequestLinking: false,
    });

    assert.include(instructions, "through the Antigravity harness, as gemini-3.8-flash.");
    assert.notInclude(instructions, "<pull_request_linking>");
  });

  it("links PRs the agent creates, takes over, or pushes to, and no others", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });

    assert.include(instructions, "Link each PR you create, take over, or push to");
    assert.include(instructions, "every stack layer");
    assert.include(instructions, "Skip PRs you only read or review");
    assert.include(instructions, "If linking fails, say so.");
    assert.notInclude(instructions, "git log -1");
    assert.notInclude(instructions, "work on");
    // Listing linked PRs as an end-of-work check found nothing to add in audited threads.
    assert.notInclude(instructions, "list_thread_pull_requests");
  });

  it("waits on a PR only with the watch, never with a poll loop", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });

    assert.notInclude(instructions, "Creation, pending checks, or a merge ask alone is not enough");
    assert.include(instructions, "Links and watches persist across pushes.");
    // The wake message itself carries the do-not-re-watch rule.
    assert.notInclude(instructions, "On a wake");
    assert.include(
      instructions,
      "Call watch_pull_request when asked to monitor or babysit, or when work you were asked to do, such as a merge, still waits on checks or reviews, even after an earlier unwatch",
    );
    assert.notInclude(instructions, "merge it now");
    assert.include(instructions, "Otherwise act now or hand back.");
    assert.include(instructions, "then watch and end your turn");
    assert.include(instructions, "never watch, even if the brief says babysit");
    assert.include(
      instructions,
      "After PR work, a child's last line is: PR <full URL>, head <SHA>, checks and reviews <state>.",
    );
    assert.include(
      instructions,
      "For PR waits, no sleep, loops, gh --watch, Monitor or ScheduleWakeup.",
    );
    assert.include(instructions, "call unwatch_pull_request");
  });
});
