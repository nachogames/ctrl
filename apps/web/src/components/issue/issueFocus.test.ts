import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { useRightPanelStore } from "~/rightPanelStore";

import { focusedIssueSurface, useIssueFocusStore, withFocusedIssue } from "./issueFocus";

const threadRef = scopeThreadRef("env-1" as EnvironmentId, "thread-1" as ThreadId);
const issue = {
  projectId: "project-1",
  tracker: "linear",
  host: "linear.app",
  scope: "ENG",
  key: "ENG-7",
  url: "https://linear.app/acme/issue/ENG-7",
};

describe("withFocusedIssue", () => {
  it("names the issue open beside the chat until the user detaches it", () => {
    expect(withFocusedIssue(threadRef, "what is left?")).toBe("what is left?");

    useRightPanelStore.getState().openIssue(threadRef, issue);
    expect(withFocusedIssue(threadRef, "what is left?")).toBe(
      "About issue ENG-7 (https://linear.app/acme/issue/ENG-7):\nwhat is left?",
    );
    // A slash command must stay the first thing in the message.
    expect(withFocusedIssue(threadRef, "/review now")).toBe("/review now");
    // A draft chat has no panel of its own.
    expect(withFocusedIssue("draft-1", "hi")).toBe("hi");

    const surface = focusedIssueSurface(useRightPanelStore.getState().byThreadKey, threadRef)!;
    useIssueFocusStore.getState().detach(scopedThreadKey(threadRef), surface.id);
    expect(withFocusedIssue(threadRef, "hi")).toBe("hi");

    // Opening another issue moves the focus, and the strip attaches it.
    const { url: _url, ...withoutUrl } = issue;
    useRightPanelStore.getState().openIssue(threadRef, { ...withoutUrl, key: "ENG-8" });
    expect(withFocusedIssue(threadRef, "hi")).toBe("About issue ENG-8 in ENG:\nhi");
  });
});
