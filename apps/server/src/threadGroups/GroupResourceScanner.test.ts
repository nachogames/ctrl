import { describe, expect, it } from "@effect/vitest";
import {
  type DiscoveredLocalServer,
  type OrchestrationThreadGroupShell,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ThreadGroupId,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadGroupStore from "../orchestration-v2/ThreadGroupStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as GroupResourceScanner from "./GroupResourceScanner.ts";

const projectId = ProjectId.make("project-1");
const groupId = ThreadGroupId.make("group-1");
const member = ThreadId.make("thread-member");
const outsider = ThreadId.make("thread-outsider");
const at = "2026-10-10T00:00:00.000Z";

const group = (worktreePath: string | null): OrchestrationThreadGroupShell => ({
  id: groupId,
  projectId,
  title: "Auth refactor",
  goal: null,
  branch: "feat/auth",
  worktreePath,
  pullRequest: null,
  lastHandoff: null,
  pinnedAt: null,
  snoozedUntil: null,
  settledAt: null,
  manualResources: [],
  createdAt: at,
  updatedAt: at,
});

const thread = (id: ThreadId, inGroup: boolean) =>
  ({ id, projectId, groupId: inGroup ? groupId : null }) as OrchestrationV2ThreadShell;

const listener = (
  port: number,
  pid: number,
  processName: string,
  terminalThread: ThreadId | null,
): DiscoveredLocalServer => ({
  host: "localhost",
  port,
  url: `http://localhost:${port}`,
  processName,
  pid,
  terminal: terminalThread === null ? null : { threadId: terminalThread, terminalId: "term-1" },
});

const listeners = [
  listener(3000, 100, "vite", member),
  listener(4000, 200, "node", outsider),
  listener(5000, 300, "next-server", null),
  listener(6000, 400, "node", null),
];

const lsofCwdOutput = ["p200", "fcwd", "n/elsewhere", "p300", "fcwd", "n/a/wt/apps/web"]
  .concat(["p400", "fcwd", "n/a/wt2", ""])
  .join("\n");

const ok = (stdout: string): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: null,
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const makeLayer = (input: {
  readonly worktreePath: string | null;
  readonly run: ProcessRunner.ProcessRunner["Service"]["run"];
}) =>
  GroupResourceScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadGroupStore.ThreadGroupStoreV2)({
          getShell: () => Effect.succeed(Option.some(group(input.worktreePath))),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          listProjectThreads: () => Effect.succeed([thread(member, true), thread(outsider, false)]),
        }),
        Layer.mock(PortScanner.PortDiscovery)({ listListeners: Effect.succeed(listeners) }),
        Layer.succeed(ProcessRunner.ProcessRunner, { run: input.run }),
        // realPath fails, so paths are compared as given.
        FileSystem.layerNoop({}),
        Layer.succeed(HostProcess.Platform, "darwin"),
      ),
    ),
  );

const scanServers = GroupResourceScanner.GroupResourceScanner.pipe(
  Effect.flatMap((scanner) => scanner.scan(groupId)),
  Effect.map((resources) => resources.map((resource) => [resource.detail, resource.source])),
);

describe("GroupResourceScanner servers", () => {
  it.effect("attributes a member's terminal server and a server running in the worktree", () => {
    const commands: Array<ReadonlyArray<string>> = [];
    return scanServers.pipe(
      Effect.tap((servers) =>
        Effect.sync(() => {
          expect(servers).toEqual([
            [":3000", "terminal"],
            [":5000", "cwd"],
          ]);
          // One batched lookup, only for listeners a member terminal does not own.
          expect(commands).toEqual([["-a", "-d", "cwd", "-p", "200,300,400", "-Fpn"]]);
        }),
      ),
      Effect.provide(
        makeLayer({
          worktreePath: "/a/wt",
          run: (run) => {
            commands.push(run.args);
            return Effect.succeed(ok(lsofCwdOutput));
          },
        }),
      ),
    );
  });

  it.effect("names a server by its process and port and links it", () =>
    GroupResourceScanner.GroupResourceScanner.pipe(
      Effect.flatMap((scanner) => scanner.scan(groupId)),
      Effect.tap((resources) =>
        Effect.sync(() =>
          expect(resources[0]).toEqual({
            id: "server:3000",
            kind: "server",
            name: "vite :3000",
            detail: ":3000",
            url: "http://localhost:3000",
            source: "terminal",
          }),
        ),
      ),
      Effect.provide(
        makeLayer({ worktreePath: "/a/wt", run: () => Effect.succeed(ok(lsofCwdOutput)) }),
      ),
    ),
  );

  it.effect("attributes by terminal only when the group has no worktree", () => {
    let lookups = 0;
    return scanServers.pipe(
      Effect.tap((servers) =>
        Effect.sync(() => {
          expect(servers).toEqual([[":3000", "terminal"]]);
          expect(lookups).toBe(0);
        }),
      ),
      Effect.provide(
        makeLayer({
          worktreePath: null,
          run: () => {
            lookups += 1;
            return Effect.succeed(ok(lsofCwdOutput));
          },
        }),
      ),
    );
  });

  it.effect("keeps terminal-attributed servers when the cwd lookup fails", () =>
    scanServers.pipe(
      Effect.tap((servers) => Effect.sync(() => expect(servers).toEqual([[":3000", "terminal"]]))),
      Effect.provide(
        makeLayer({
          worktreePath: "/a/wt",
          run: (run) =>
            Effect.fail(
              new ProcessRunner.ProcessTimeoutError({
                command: run.command,
                argumentCount: run.args.length,
                timeoutMs: 5_000,
              }),
            ),
        }),
      ),
    ),
  );
});
