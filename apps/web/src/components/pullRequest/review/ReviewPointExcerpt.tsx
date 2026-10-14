import { FileDiff } from "@pierre/diffs/react";
import { useMemo } from "react";

import { DiffWorkerPoolProvider } from "~/components/DiffWorkerPoolProvider";
import { useTheme } from "~/hooks/useTheme";
import {
  buildFileDiffIdentityKey,
  getRenderablePatch,
  resolveDiffThemeName,
} from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";

/** Render captured review hunks with their original line numbers, without fetching source. */
export function ReviewPointExcerpt({
  path,
  line,
  excerpt,
}: {
  path: string | null;
  line: number | null;
  excerpt: string | null;
}) {
  const { resolvedTheme } = useTheme();
  const patch = useMemo(() => {
    if (!excerpt) return null;
    const hunk = excerpt.trimStart();
    // GitHub's diffHunk omits file headers. Use a neutral parser path; the actual path is below.
    return getRenderablePatch(
      hunk.startsWith("@@")
        ? `diff --git a/review b/review\n--- a/review\n+++ b/review\n${excerpt}`
        : excerpt,
      "review-point",
    );
  }, [excerpt]);
  if (!path && !excerpt) return null;
  return (
    <div className="overflow-hidden rounded-lg border border-border/60">
      {path ? (
        <div className="break-all border-b border-border/60 bg-muted/40 px-3 py-2 font-mono text-xs">
          {path}
          {line === null ? "" : `:${line}`}
        </div>
      ) : null}
      {patch?.kind === "files" ? (
        <DiffWorkerPoolProvider>
          {patch.files.map((file) => (
            <FileDiff
              key={buildFileDiffIdentityKey(file)}
              fileDiff={file}
              options={{
                disableFileHeader: true,
                diffStyle: "unified",
                overflow: "scroll",
                theme: resolveDiffThemeName(resolvedTheme),
                themeType: resolvedTheme,
                preferredHighlighter: PREFERRED_HIGHLIGHTER,
              }}
            />
          ))}
        </DiffWorkerPoolProvider>
      ) : excerpt ? (
        <pre className="overflow-x-auto py-3 text-xs">
          {excerpt.split("\n").map((text, index) => (
            <span
              key={`${index}:${text}`}
              className={`block min-w-max px-3 ${
                text.startsWith("+") && !text.startsWith("+++")
                  ? "bg-diff-addition/15 text-diff-addition-foreground"
                  : text.startsWith("-") && !text.startsWith("---")
                    ? "bg-diff-deletion/15 text-diff-deletion-foreground"
                    : ""
              }`}
            >
              {text || " "}
            </span>
          ))}
        </pre>
      ) : null}
    </div>
  );
}
