import { VoiceFrontError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import { frontNotSetUp } from "./voiceFrontSetup";

const failure = (reason: VoiceFrontError["reason"]) =>
  Cause.fail(new VoiceFrontError({ reason, message: reason }));

describe("frontNotSetUp", () => {
  it("counts a machine with the quick voice off, missing, or unstartable", () => {
    for (const reason of [
      "disabled",
      "lm-studio-missing",
      "server-unavailable",
      "model-missing",
      "model-too-large",
    ] as const)
      expect(frontNotSetUp(failure(reason))).toBe(true);
  });

  it("counts a server too old to have the front voice", () => {
    expect(frontNotSetUp(Cause.die("Unknown request tag: voiceFront.respond"))).toBe(true);
  });

  it("does not count a reply that failed partway, or a dropped connection", () => {
    expect(frontNotSetUp(failure("generation-failed"))).toBe(false);
    expect(frontNotSetUp(Cause.die(new Error("socket closed")))).toBe(false);
    expect(frontNotSetUp(Cause.interrupt())).toBe(false);
  });
});
