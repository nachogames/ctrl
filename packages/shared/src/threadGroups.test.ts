import { describe, expect, it } from "vite-plus/test";

import { groupLinkLabel, pullRequestTitleIssueLinks } from "./threadGroups.ts";

describe("groupLinkLabel", () => {
  it("names a Linear issue by its key, ignoring the slug, query and hash", () => {
    expect(groupLinkLabel("https://linear.app/acme/issue/eng-123/fix-login?ref=x#c")).toBe(
      "ENG-123",
    );
  });

  it("names a GitHub issue or pull request by its number, on any host", () => {
    expect(groupLinkLabel("https://github.com/t3tools/t3code/issues/88")).toBe("#88");
    expect(groupLinkLabel("https://github.example.com/org/repo/pull/12/files")).toBe("#12");
  });

  it("falls back to the host and refuses what is not a web address", () => {
    expect(groupLinkLabel("https://jira.example.com/browse/OPS-1")).toBe("jira.example.com");
    expect(groupLinkLabel("not a url")).toBeNull();
    expect(groupLinkLabel("ftp://example.com/x")).toBeNull();
  });
});

describe("pullRequestTitleIssueLinks", () => {
  const pr = { host: "github.com", repository: "t3tools/t3code", number: 412 };

  it("links each #ref once to the pull request's repository, skipping the pull request", () => {
    expect(
      pullRequestTitleIssueLinks({ ...pr, title: "Fixes #88 and #91, refs #88 (#412)" }),
    ).toEqual([
      { label: "#88", url: "https://github.com/t3tools/t3code/issues/88" },
      { label: "#91", url: "https://github.com/t3tools/t3code/issues/91" },
    ]);
  });

  it("ignores refs inside words and URLs", () => {
    expect(
      pullRequestTitleIssueLinks({ ...pr, title: "Bump abc#12, see https://x.test/#34" }),
    ).toEqual([]);
  });
});
