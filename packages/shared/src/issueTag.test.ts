import { describe, expect, it } from "vitest";

import { formatIssueTag, parseIssueTag } from "./issueTag";

describe("issue tag", () => {
  it("round-trips the key, link and message", () => {
    const url = "https://linear.app/acme/issue/ENG-7/fix-it";
    expect(parseIssueTag(formatIssueTag({ key: "ENG-7", url }, "why?\nmore"))).toEqual({
      key: "ENG-7",
      url,
      body: "why?\nmore",
    });
    expect(parseIssueTag(formatIssueTag({ key: "12", scope: "acme/web" }, "hi"))).toEqual({
      key: "12",
      url: null,
      body: "hi",
    });
  });

  it("leaves a message that only mentions an issue alone", () => {
    expect(parseIssueTag("About issue ENG-7 I think we should\nwait")).toBeNull();
    expect(parseIssueTag("hello\nAbout issue ENG-7:\nx")).toBeNull();
  });
});
