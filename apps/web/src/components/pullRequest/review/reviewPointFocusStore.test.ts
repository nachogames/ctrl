import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  readAttachedReviewPoint,
  useReviewPointFocusStore,
  withAttachedReviewPoint,
} from "./reviewPointFocusStore";

const key = "environment:thread:review";

describe("review point focus", () => {
  beforeEach(() =>
    useReviewPointFocusStore.setState({
      focus: {},
      reviewChats: {},
      openRequest: null,
      requestedPoints: {},
    }),
  );

  it("attaches the open point, detaches on ×, and re-attaches when another opens", () => {
    const store = useReviewPointFocusStore.getState();
    store.openPoint(key, { number: 2, label: "build cache key" });
    expect(readAttachedReviewPoint(key)).toEqual({ number: 2, label: "build cache key" });
    store.detach(key);
    expect(readAttachedReviewPoint(key)).toBeNull();
    expect(useReviewPointFocusStore.getState().focus[key]?.number).toBe(2);
    store.attach(key);
    expect(readAttachedReviewPoint(key)?.number).toBe(2);
    store.detach(key);
    store.openPoint(key, { number: 3, label: "pin version" });
    expect(readAttachedReviewPoint(key)).toEqual({ number: 3, label: "pin version" });
    store.closePoint(key);
    expect(readAttachedReviewPoint(key)).toBeNull();
  });

  it("tags a message only while its point is attached", () => {
    const store = useReviewPointFocusStore.getState();
    expect(withAttachedReviewPoint(key, "why?")).toBe("why?");
    store.openPoint(key, { number: 2, label: "build cache key" });
    expect(withAttachedReviewPoint(key, "why?")).toBe("[#2 build cache key]\nwhy?");
    store.detach(key);
    expect(withAttachedReviewPoint(key, "why?")).toBe("why?");
  });

  it("leaves a slash command first, so the provider still runs it", () => {
    useReviewPointFocusStore.getState().openPoint(key, { number: 2, label: "build cache key" });
    expect(withAttachedReviewPoint(key, "/compact")).toBe("/compact");
    expect(withAttachedReviewPoint(key, "/review-pr focus on #2")).toBe("/review-pr focus on #2");
    // A path is prose, not a command, and a skill mention works anywhere in the message.
    expect(withAttachedReviewPoint(key, "/tmp/out.log is empty")).toBe(
      "[#2 build cache key]\n/tmp/out.log is empty",
    );
    expect(withAttachedReviewPoint(key, "$review-pr on this")).toBe(
      "[#2 build cache key]\n$review-pr on this",
    );
  });

  it("sends only the skills the user typed, never one named in the point's label", () => {
    useReviewPointFocusStore.getState().openPoint(key, { number: 4, label: "use $deploy here" });
    const skills = (text: string) =>
      [...withAttachedReviewPoint(key, text).matchAll(SKILL_MENTION_PATTERN)].map(
        (match) => match[2],
      );
    expect(skills("why?")).toEqual([]);
    expect(skills("try $review-pr")).toEqual(["review-pr"]);
  });

  it("hands a tag's point to the Review tab without attaching it", () => {
    const store = useReviewPointFocusStore.getState();
    store.requestOpen(key, 3);
    expect(readAttachedReviewPoint(key)).toBeNull();
    expect(useReviewPointFocusStore.getState().requestedPoints[key]).toBe(3);
    store.takeRequestedPoint(key);
    expect(useReviewPointFocusStore.getState().requestedPoints[key]).toBeUndefined();
  });
});
