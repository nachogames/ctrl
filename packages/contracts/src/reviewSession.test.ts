import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  reviewerPointKind,
  reviewRole,
  ReviewItemSource,
  ReviewItemsDecideInput,
  ReviewRequestInput,
  ReviewSessionSubscribeResult,
} from "./reviewSession.ts";

const decodeSource = Schema.decodeUnknownSync(ReviewItemSource);
const decodeDecide = Schema.decodeUnknownSync(ReviewItemsDecideInput);
const decodeRequest = Schema.decodeUnknownSync(ReviewRequestInput);
const decodeSubscribeResult = Schema.decodeUnknownSync(ReviewSessionSubscribeResult);

describe("ReviewItemSource", () => {
  it("accepts the reviewers the loop knows", () => {
    for (const source of [
      "copilot",
      "local-review",
      "ci",
      "you",
      "human:octocat",
      "human:renovate[bot]",
    ]) {
      expect(decodeSource(source)).toBe(source);
    }
  });

  it("rejects anything else", () => {
    for (const source of ["github", "human:", "Copilot", "human:has space"]) {
      expect(() => decodeSource(source)).toThrow();
    }
  });
});

describe("ReviewItemsDecideInput", () => {
  it("takes the three decisions and nothing else", () => {
    expect(
      decodeDecide({
        sessionId: "review:1",
        number: 3,
        decision: "decline",
        reason: "Out of scope",
      }),
    ).toEqual({ sessionId: "review:1", number: 3, decision: "decline", reason: "Out of scope" });
    expect(() => decodeDecide({ sessionId: "review:1", number: 3, decision: "maybe" })).toThrow();
    expect(() => decodeDecide({ sessionId: "review:1", number: 0, decision: "fix" })).toThrow();
  });
});

describe("ReviewRequestInput", () => {
  it("asks the review chat to triage, apply, or rewrite one reply", () => {
    expect(decodeRequest({ sessionId: "review:1", request: { _tag: "triage" } }).request).toEqual({
      _tag: "triage",
    });
    expect(
      decodeRequest({
        sessionId: "review:1",
        request: { _tag: "rewrite-reply", number: 2, style: "shorter" },
      }).request,
    ).toEqual({ _tag: "rewrite-reply", number: 2, style: "shorter" });
    expect(() =>
      decodeRequest({
        sessionId: "review:1",
        request: { _tag: "rewrite-reply", number: 2, style: "louder" },
      }),
    ).toThrow();
  });
});

describe("ReviewSessionSubscribeResult", () => {
  it("reads a pull request with no review as a null snapshot", () => {
    expect(decodeSubscribeResult({ snapshot: null })).toEqual({ snapshot: null });
  });
});

describe("reviewRole", () => {
  it("is the author's loop until both logins are known and differ", () => {
    expect(reviewRole({ authorLogin: "nach", viewerLogin: "NACH" })).toBe("author");
    expect(reviewRole({ authorLogin: "dan", viewerLogin: null })).toBe("author");
    expect(reviewRole({})).toBe("author");
    expect(reviewRole({ authorLogin: "dan", viewerLogin: "nach" })).toBe("reviewer");
  });
});

describe("reviewerPointKind", () => {
  const point = (
    sources: ReadonlyArray<string>,
    round = 2,
    threads: ReadonlyArray<string> = [],
  ) => ({ sources: sources as ReadonlyArray<ReviewItemSource>, round, githubThreadIds: threads });

  it("names what each point asks of the reviewer", () => {
    expect(reviewerPointKind(point(["copilot"]), 2)).toBe("context");
    expect(reviewerPointKind(point(["local-review", "human:dan"]), 2)).toBe("overlap");
    expect(reviewerPointKind(point(["local-review"], 1, ["PRRT_1"]), 2)).toBe("follow-up");
    expect(reviewerPointKind(point(["you"], 1, ["PRRT_1"]), 2)).toBe("follow-up");
    // Skipped last round, so it never got a thread: it is a new finding again.
    expect(reviewerPointKind(point(["local-review"], 1), 2)).toBe("finding");
    expect(reviewerPointKind(point(["local-review"], 2, ["PRRT_1"]), 2)).toBe("finding");
  });
});
