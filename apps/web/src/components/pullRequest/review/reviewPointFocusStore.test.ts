import { beforeEach, describe, expect, it } from "vite-plus/test";

import { readAttachedReviewPoint, useReviewPointFocusStore } from "./reviewPointFocusStore";

const key = "environment:thread:review";

describe("review point focus", () => {
  beforeEach(() =>
    useReviewPointFocusStore.setState({ focus: {}, reviewChats: {}, openRequest: null }),
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
});
