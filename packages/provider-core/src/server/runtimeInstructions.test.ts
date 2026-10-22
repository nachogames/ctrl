import { describe, expect, it } from "vite-plus/test";
import { buildRuntimeInstructions } from "./runtimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it.each(["Codex", "Claude Code", "Cursor", "OpenCode", "Grok", "Antigravity", "Muse"])(
    "routes PR reviews through persistent sessions for %s without project skills",
    (harness) => {
      const instructions = buildRuntimeInstructions({ harness });
      expect(instructions).toContain("no repository-installed review-pr skill is required");
      expect(instructions).toContain("call t3_group_create with no arguments");
      expect(instructions).toContain("review_session_open with url and headSha");
      expect(instructions).toContain("do not create a duplicate review");
      expect(instructions).toContain("any ordinary chat in that group may read, import, annotate");
      expect(instructions).toContain(
        "A different session.reviewThreadId is not a write restriction",
      );
      expect(instructions).not.toContain("continue there only when authorized");
      expect(instructions).toContain("triage the imported feedback");
      expect(instructions).toContain("Questions do not change decisions");
      expect(instructions).toContain("If review tools are unavailable");
    },
  );
});
