import { describe, expect, it } from "@effect/vitest";
import {
  type DiscoveredLocalServer,
  type OrchestrationThreadGroupShell,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ThreadGroupId,
  ThreadId,
  type ThreadGroupRunningResource,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadGroupStore from "../orchestration-v2/ThreadGroupStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as ProcessRunner from "../processRunner.ts";
import type { DockerContainer } from "./DockerScanner.ts";
import * as DockerScanner from "./DockerScanner.ts";
import * as GroupResourceScanner from "./GroupResourceScanner.ts";

const projectId = ProjectId.make("project-1");
const groupId = ThreadGroupId.make("group-1");
const member = ThreadId.make("thread-member");
const outsider = ThreadId.make("thread-outsider");
const at = "2026-10-10T00:00:00.000Z";

const group = (
  worktreePath: string | null,
  manualResources: OrchestrationThreadGroupShell["manualResources"] = [],
): OrchestrationThreadGroupShell => ({
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
  manualResources,
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
  readonly manualResources?: OrchestrationThreadGroupShell["manualResources"];
  readonly listContainers?: Effect.Effect<ReadonlyArray<DockerContainer>>;
}) =>
  GroupResourceScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadGroupStore.ThreadGroupStoreV2)({
          getShell: () =>
            Effect.succeed(Option.some(group(input.worktreePath, input.manualResources))),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          listProjectThreads: () => Effect.succeed([thread(member, true), thread(outsider, false)]),
        }),
        Layer.mock(PortScanner.PortDiscovery)({ listListeners: Effect.succeed(listeners) }),
        Layer.mock(DockerScanner.DockerScanner)({
          listContainers: input.listContainers ?? Effect.succeed([]),
        }),
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

const container = (
  id: string,
  workingDir: string | null,
  overrides: Partial<DockerContainer> = {},
): DockerContainer => ({
  id,
  name: `${id}-1`,
  service: null,
  workingDir,
  publishedPorts: [],
  ...overrides,
});

const scanAll = GroupResourceScanner.GroupResourceScanner.pipe(
  Effect.flatMap((scanner) => scanner.scan(groupId)),
);

describe("GroupResourceScanner containers and registered resources", () => {
  it.effect("attributes containers by their compose working_dir label", () =>
    scanAll.pipe(
      Effect.tap((resources) =>
        Effect.sync(() =>
          expect(resources.filter((resource) => resource.kind === "container")).toEqual([
            {
              id: "container:db",
              kind: "container",
              name: "postgres",
              detail: "docker",
              url: "http://localhost:5432",
              source: "docker",
            },
            {
              id: "container:cache",
              kind: "container",
              name: "cache-1",
              detail: "docker",
              url: null,
              source: "docker",
            },
          ]),
        ),
      ),
      Effect.provide(
        makeLayer({
          worktreePath: "/a/wt",
          run: () => Effect.succeed(ok("")),
          listContainers: Effect.succeed([
            container("db", "/a/wt", { service: "postgres", publishedPorts: [5432, 5433] }),
            container("cache", "/a/wt/infra"),
            container("sibling", "/a/wt2"),
            container("loose", null),
          ]),
        }),
      ),
    ),
  );

  it.effect("never asks Docker for a group without a worktree", () => {
    let dockerScans = 0;
    return scanAll.pipe(
      Effect.tap((resources) =>
        Effect.sync(() => {
          expect(resources.map((resource) => resource.kind)).toEqual(["server"]);
          expect(dockerScans).toBe(0);
        }),
      ),
      Effect.provide(
        makeLayer({
          worktreePath: null,
          run: () => Effect.succeed(ok("")),
          listContainers: Effect.sync(() => {
            dockerScans += 1;
            return [container("db", "/a/wt")];
          }),
        }),
      ),
    );
  });

  it.effect(
    "lists servers, then containers, then registered resources a server does not cover",
    () =>
      scanAll.pipe(
        Effect.tap((resources) =>
          Effect.sync(() =>
            expect(resources.map((resource) => [resource.id, resource.detail])).toEqual([
              ["server:3000", ":3000"],
              ["server:5000", ":5000"],
              ["container:db", "docker"],
              ["manual:staging", "https://staging.example.test"],
              ["manual:notes", "registered"],
              ["manual:other", "http://localhost:6000"],
            ]),
          ),
        ),
        Effect.provide(
          makeLayer({
            worktreePath: "/a/wt",
            run: () => Effect.succeed(ok(lsofCwdOutput)),
            listContainers: Effect.succeed([container("db", "/a/wt")]),
            manualResources: [
              // The scanned :3000 server replaces this one.
              { id: "web", name: "Web", url: "http://127.0.0.1:3000/app", kind: "server" },
              {
                id: "staging",
                name: "Staging",
                url: "https://staging.example.test",
                kind: "server",
              },
              { id: "notes", name: "Notes", url: null, kind: "other" },
              // :6000 is listening but not the group's, so the registered one stays.
              { id: "other", name: "Other", url: "http://localhost:6000", kind: "server" },
            ],
          }),
        ),
      ),
  );
});

describe("listenersNeedingCwd", () => {
  it("never looks up the T3 server's own process", () => {
    const scope = { memberThreadIds: new Set([member]), worktreeRoot: "/a/wt" };
    expect(GroupResourceScanner.listenersNeedingCwd(listeners, scope, 300)).toEqual([200, 400]);
  });
});

const resource = (id: string): ThreadGroupRunningResource => ({
  id,
  kind: id.startsWith("container:") ? "container" : "server",
  name: id,
  detail: id.startsWith("container:") ? "docker" : ":3000",
  url: null,
  source: id.startsWith("container:") ? "docker" : "terminal",
});

/** A feed over a scan whose result the test changes, counting scans and watches. */
const makeTestFeed = Effect.gen(function* () {
  const state = {
    resources: [resource("server:3000")] as ReadonlyArray<ThreadGroupRunningResource> | null,
    scans: 0,
    dieOnce: false,
    watching: 0,
    wake: Effect.void as Effect.Effect<void>,
  };
  const feed = yield* GroupResourceScanner.makeResourceFeed({
    scan: () =>
      Effect.suspend(() => {
        state.scans += 1;
        if (state.dieOnce) {
          state.dieOnce = false;
          return Effect.die(new Error("scanner bug"));
        }
        return Effect.succeed(state.resources);
      }),
    watch: (wake) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          state.watching += 1;
          state.wake = wake;
        }),
        () => Effect.sync(() => (state.watching -= 1)),
      ),
    interval: Duration.seconds(5),
  });
  const watch = Effect.gen(function* () {
    const seen: Array<ReadonlyArray<string>> = [];
    const fiber = yield* Effect.forkChild(
      feed
        .changes(groupId)
        .pipe(
          Stream.runForEach((resources) =>
            Effect.sync(() => seen.push(resources.map((entry) => entry.id))),
          ),
        ),
    );
    return { seen, fiber };
  });
  return { state, watch };
});

const tick = TestClock.adjust(Duration.seconds(5));

describe("GroupResourceScanner.makeResourceFeed", () => {
  it.effect("emits the first list, stays quiet while it holds, and emits a new container", () =>
    Effect.gen(function* () {
      const { state, watch } = yield* makeTestFeed;
      const { seen } = yield* watch;
      yield* TestClock.adjust(Duration.zero);
      expect(seen).toEqual([["server:3000"]]);

      yield* tick;
      expect(state.scans).toBe(2);
      expect(seen).toHaveLength(1);

      state.resources = [resource("server:3000"), resource("container:db")];
      yield* tick;
      expect(state.scans).toBe(3);
      expect(seen).toEqual([["server:3000"], ["server:3000", "container:db"]]);
    }),
  );

  it.effect("runs one scan per tick for every watcher of a group, and stops after the last", () =>
    Effect.gen(function* () {
      const { state, watch } = yield* makeTestFeed;
      const first = yield* watch;
      const second = yield* watch;
      yield* TestClock.adjust(Duration.zero);
      expect(state.scans).toBe(1);
      expect(state.watching).toBe(1);

      yield* tick;
      yield* tick;
      expect(state.scans).toBe(3);
      expect(first.seen).toEqual([["server:3000"]]);
      expect(second.seen).toEqual([["server:3000"]]);

      yield* Fiber.interrupt(first.fiber);
      yield* tick;
      expect(state.scans).toBe(4);
      yield* Fiber.interrupt(second.fiber);
      expect(state.watching).toBe(0);
      yield* tick;
      expect(state.scans).toBe(4);
    }),
  );

  it.effect("rescans as soon as the watch wakes it", () =>
    Effect.gen(function* () {
      const { state, watch } = yield* makeTestFeed;
      const { seen } = yield* watch;
      yield* TestClock.adjust(Duration.zero);
      state.resources = [resource("server:3000"), resource("server:4000")];
      yield* state.wake;
      yield* TestClock.adjust(Duration.zero);
      expect(state.scans).toBe(2);
      expect(seen).toEqual([["server:3000"], ["server:3000", "server:4000"]]);
    }),
  );

  it.effect("keeps the last list when a scan fails, and starts empty when the first one does", () =>
    Effect.gen(function* () {
      const { state, watch } = yield* makeTestFeed;
      state.resources = null;
      const { seen } = yield* watch;
      yield* TestClock.adjust(Duration.zero);
      expect(seen).toEqual([[]]);

      state.resources = [resource("server:3000")];
      yield* tick;
      state.resources = null;
      yield* tick;
      expect(state.scans).toBe(3);
      expect(seen).toEqual([[], ["server:3000"]]);
    }),
  );

  it.effect("keeps scanning after a scan dies", () =>
    Effect.gen(function* () {
      const { state, watch } = yield* makeTestFeed;
      const { seen } = yield* watch;
      yield* TestClock.adjust(Duration.zero);

      state.dieOnce = true;
      state.resources = [resource("server:3000"), resource("container:db")];
      yield* tick;
      expect(state.scans).toBe(2);
      expect(seen).toEqual([["server:3000"]]);

      yield* tick;
      expect(state.scans).toBe(3);
      expect(seen).toEqual([["server:3000"], ["server:3000", "container:db"]]);
    }),
  );

  it.effect("does not emit when a scan only reorders the list", () =>
    Effect.gen(function* () {
      const { state, watch } = yield* makeTestFeed;
      state.resources = [resource("server:3000"), resource("container:db")];
      const { seen } = yield* watch;
      yield* TestClock.adjust(Duration.zero);

      state.resources = [resource("container:db"), resource("server:3000")];
      yield* tick;
      expect(state.scans).toBe(2);
      expect(seen).toEqual([["server:3000", "container:db"]]);
    }),
  );
});
