// @effect-diagnostics nodeBuiltinImport:off - Reads the repository's skill files and a scratch copy.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  REVIEW_SKILLS,
  reviewSkillDrift,
  reviewSkillSource,
  syncReviewSkills,
} from "./sync-review-skills.ts";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const scratch: Array<string> = [];

afterEach(() => {
  for (const directory of scratch.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
});

describe("review skills", () => {
  it("lives once in .agents/skills, which Claude reads through its symlink", () => {
    for (const skill of REVIEW_SKILLS) {
      expect(
        NodeFS.realpathSync(NodePath.join(repoRoot, ".claude", "skills", skill, "SKILL.md")),
      ).toBe(NodeFS.realpathSync(reviewSkillSource(repoRoot, skill)));
      const text = NodeFS.readFileSync(reviewSkillSource(repoRoot, skill), "utf8");
      expect(text.startsWith(`---\nname: ${skill}\ndescription: `)).toBe(true);
      expect(text).toContain("review_session_open");
    }
  });

  it("keeps Cursor's copies identical to the source", () => {
    expect(reviewSkillDrift(repoRoot)).toEqual([]);
  });

  it("finds a drifted copy and the sync puts it back", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ctrl-review-skills-"));
    scratch.push(root);
    for (const skill of REVIEW_SKILLS) {
      NodeFS.mkdirSync(NodePath.dirname(reviewSkillSource(root, skill)), { recursive: true });
      NodeFS.writeFileSync(reviewSkillSource(root, skill), `---\nname: ${skill}\n---\n`);
    }
    expect(reviewSkillDrift(root)).toHaveLength(REVIEW_SKILLS.length);
    expect(syncReviewSkills(root)).toHaveLength(REVIEW_SKILLS.length);
    expect(reviewSkillDrift(root)).toEqual([]);
    expect(syncReviewSkills(root)).toEqual([]);
  });
});
