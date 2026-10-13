import { describe, expect, it } from "vite-plus/test";

import { reviewStackNeighbours } from "./reviewStack.ts";
import { prKey, prLink } from "./testkit.ts";

describe("reviewStackNeighbours", () => {
  it("lists the PRs below and above this one, once each", () => {
    const links = [
      prLink(22, "feat/base", "main"),
      prLink(23, "fix/fingerprint", "feat/base"),
      prLink(24, "chore/pin", "fix/fingerprint"),
      // The same PR linked from another chat.
      prLink(24, "chore/pin", "fix/fingerprint"),
      prLink(40, "unrelated", "main"),
    ];
    expect(reviewStackNeighbours(links, prKey).map((n) => [n.number, n.relation])).toEqual([
      [22, "base"],
      [24, "stacked"],
    ]);
  });

  it("is empty for a PR on its own", () => {
    expect(reviewStackNeighbours([prLink(23, "fix/fingerprint", "main")], prKey)).toEqual([]);
  });
});
