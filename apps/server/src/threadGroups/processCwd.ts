/**
 * Working directories of local processes, so a listener can be attributed to
 * the worktree it was started in.
 *
 * macOS/Linux: one batched `lsof -a -d cwd -p <pids> -Fpn`. Linux without
 * `lsof`: `readlink /proc/<pid>/cwd`. Windows: none, so only terminal
 * attribution applies there. Every failure degrades to "unknown".
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";

import * as ProcessRunner from "../processRunner.ts";

const CWD_CACHE_TTL_MS = Duration.toMillis(Duration.seconds(30));
const LSOF_TIMEOUT = Duration.seconds(5);

/** Pid to working directory from `lsof -Fpn` output; a pid without an `n` line is absent. */
export const parseLsofCwd = (raw: string): ReadonlyMap<number, string> => {
  const cwds = new Map<number, string>();
  let pid: number | null = null;
  for (const line of raw.split("\n")) {
    const tag = line.charAt(0);
    const value = line.slice(1);
    if (tag === "p") {
      const parsed = Number.parseInt(value, 10);
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
      continue;
    }
    if (tag === "n" && pid !== null && value.length > 0 && !cwds.has(pid)) {
      cwds.set(pid, value);
    }
  }
  return cwds;
};

const trimTrailingSeparators = (path: string) => path.replace(/(?<=.)[\\/]+$/, "");

/** Whether `child` is `root` or below it. Both must already be absolute and resolved. */
export const isPathInside = (root: string, child: string): boolean => {
  const normalizedRoot = trimTrailingSeparators(root);
  const normalizedChild = trimTrailingSeparators(child);
  if (normalizedChild === normalizedRoot) return true;
  const separator = normalizedRoot.includes("/") ? "/" : "\\";
  const prefix = normalizedRoot.endsWith(separator)
    ? normalizedRoot
    : `${normalizedRoot}${separator}`;
  return normalizedChild.startsWith(prefix);
};

/** `path` without symlinks when it resolves, else as given. */
export const resolveRealPath = (fileSystem: FileSystem.FileSystem, path: string) =>
  fileSystem.realPath(path).pipe(Effect.orElseSucceed(() => path));

interface CwdCacheEntry {
  readonly cwd: string | null;
  readonly expiresAtMillis: number;
}

/**
 * Builds a cwd lookup that caches each pid's answer for 30 s. A failed batch
 * caches nothing, so the next lookup asks again.
 */
export const makeProcessCwdLookup = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const cacheRef = yield* Ref.make<ReadonlyMap<number, CwdCacheEntry>>(new Map());
  const lsofMissingRef = yield* Ref.make(false);

  const fromProc = (pids: ReadonlyArray<number>) =>
    Effect.forEach(
      pids,
      (pid) =>
        fileSystem.readLink(`/proc/${pid}/cwd`).pipe(
          Effect.map((cwd) => [pid, cwd] as const),
          Effect.orElseSucceed(() => [pid, null] as const),
        ),
      { concurrency: 16 },
    ).pipe(
      Effect.map(
        (entries) =>
          new Map(entries.flatMap(([pid, cwd]) => (cwd === null ? [] : [[pid, cwd] as const]))),
      ),
    );

  /** Null when the lookup itself failed, as opposed to finding nothing. */
  const fromLsof = (pids: ReadonlyArray<number>) =>
    processRunner
      .run({
        command: "lsof",
        args: ["-a", "-d", "cwd", "-p", pids.join(","), "-Fpn"],
        timeout: LSOF_TIMEOUT,
        maxOutputBytes: 1024 * 1024,
      })
      // lsof exits 1 when one of the pids is gone; the rest of its output still counts.
      .pipe(
        Effect.map((result): ReadonlyMap<number, string> | null => parseLsofCwd(result.stdout)),
        Effect.catchTags({
          ProcessSpawnError: (error) =>
            PlatformError.isPlatformError(error.cause) && error.cause.reason._tag === "NotFound"
              ? Ref.set(lsofMissingRef, true).pipe(Effect.as(null))
              : Effect.succeed(null),
        }),
        Effect.catchCause((cause) =>
          Effect.logDebug("group resource cwd lookup failed", { cause }).pipe(Effect.as(null)),
        ),
      );

  const lookupUncached = Effect.fn("ProcessCwd.lookupUncached")(function* (
    pids: ReadonlyArray<number>,
  ) {
    if (platform === "win32") return null;
    if (!(yield* Ref.get(lsofMissingRef))) {
      const viaLsof = yield* fromLsof(pids);
      if (viaLsof !== null) return viaLsof;
      if (!(yield* Ref.get(lsofMissingRef))) return null;
    }
    return platform === "linux" ? yield* fromProc(pids) : null;
  });

  /** Resolved working directories of the pids that have a known one. */
  const lookup = Effect.fn("ProcessCwd.lookup")(function* (pids: ReadonlyArray<number>) {
    const now = yield* Clock.currentTimeMillis;
    const cached = yield* Ref.get(cacheRef);
    const wanted = [...new Set(pids)];
    const missing = wanted.filter((pid) => (cached.get(pid)?.expiresAtMillis ?? 0) <= now);
    const fresh = missing.length === 0 ? new Map<number, string>() : yield* lookupUncached(missing);
    const next = new Map([...cached].filter(([, entry]) => entry.expiresAtMillis > now));
    if (fresh !== null) {
      const resolved = yield* Effect.forEach(
        missing,
        (pid): Effect.Effect<readonly [number, string | null]> => {
          const cwd = fresh.get(pid);
          return cwd === undefined
            ? Effect.succeed([pid, null])
            : resolveRealPath(fileSystem, cwd).pipe(Effect.map((real) => [pid, real] as const));
        },
        { concurrency: 16 },
      );
      for (const [pid, cwd] of resolved) {
        next.set(pid, { cwd, expiresAtMillis: now + CWD_CACHE_TTL_MS });
      }
    }
    yield* Ref.set(cacheRef, next);
    const cwds = new Map<number, string>();
    for (const pid of wanted) {
      const cwd = next.get(pid)?.cwd;
      if (cwd != null) cwds.set(pid, cwd);
    }
    return cwds as ReadonlyMap<number, string>;
  });

  return { lookup };
});
