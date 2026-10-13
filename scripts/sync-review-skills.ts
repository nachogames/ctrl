// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Copies two small skill files inside the repository and prints what it wrote.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** The review loop's skills. Their rules live in the brief review_session_open returns. */
export const REVIEW_SKILLS = ["review-pr", "apply-pr-review"] as const;

/** The one source. Codex reads `.agents/skills`, and `.claude/skills` is a symlink to it. */
export const reviewSkillSource = (repoRoot: string, skill: string) =>
  NodePath.join(repoRoot, ".agents", "skills", skill, "SKILL.md");

/** Cursor reads `.cursor/skills`, so it gets a copy. */
export const reviewSkillCursorCopy = (repoRoot: string, skill: string) =>
  NodePath.join(repoRoot, ".cursor", "skills", skill, "SKILL.md");

const readOrNull = (path: string) =>
  NodeFS.existsSync(path) ? NodeFS.readFileSync(path, "utf8") : null;

/** One line per copy that is missing or differs from its source. */
export function reviewSkillDrift(repoRoot: string): ReadonlyArray<string> {
  return REVIEW_SKILLS.flatMap((skill) => {
    const source = readOrNull(reviewSkillSource(repoRoot, skill));
    if (source === null) return [`${skill}: no source at .agents/skills/${skill}/SKILL.md`];
    return readOrNull(reviewSkillCursorCopy(repoRoot, skill)) === source
      ? []
      : [
          `${skill}: .cursor/skills/${skill}/SKILL.md differs from .agents/skills (run node scripts/sync-review-skills.ts)`,
        ];
  });
}

/** Copies each source over Cursor's copy; returns the paths it wrote. */
export function syncReviewSkills(repoRoot: string): ReadonlyArray<string> {
  return REVIEW_SKILLS.flatMap((skill) => {
    const source = readOrNull(reviewSkillSource(repoRoot, skill));
    const target = reviewSkillCursorCopy(repoRoot, skill);
    if (source === null || readOrNull(target) === source) return [];
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, source);
    return [target];
  });
}

if (import.meta.main) {
  const written = syncReviewSkills(NodePath.resolve(import.meta.dirname, ".."));
  console.log(written.length === 0 ? "Review skills already in sync." : written.join("\n"));
}
