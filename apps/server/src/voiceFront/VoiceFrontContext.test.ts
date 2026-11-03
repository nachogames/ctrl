import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  type OrchestrationV2ThreadShell,
  type OrchestratorMcpThreadListItem,
  type PeerLinkStatus,
  type PeerLinkSummary,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import { contextText, SNAPSHOT_THREAD_LIMIT } from "./frontPrompt.ts";
import * as VoiceFrontContext from "./VoiceFrontContext.ts";

const here = EnvironmentId.make("laptop");
const studio = EnvironmentId.make("studio");
const tower = EnvironmentId.make("tower");
const homeThreadId = ThreadId.make("home:shift");
const NOW = 10 * 60_000;

const shell = (id: string, updatedAt: number) =>
  ({
    id: ThreadId.make(id),
    projectId: ProjectId.make("p"),
    title: id,
    status: "idle",
    activityRunStatus: null,
    settledOverride: null,
    pendingRuntimeRequest: null,
    hasActionableProposedPlan: false,
    latestVisibleMessage: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: null },
    deletedAt: null,
    archivedAt: null,
    updatedAt: DateTime.makeUnsafe(updatedAt),
  }) as unknown as OrchestrationV2ThreadShell;

const item = (
  id: string,
  updatedAt: number,
  overrides: Partial<OrchestratorMcpThreadListItem> = {},
) =>
  ({
    threadId: ThreadId.make(id),
    title: id,
    status: "running",
    settled: false,
    needs: null,
    relationshipToParent: null,
    updatedAt: DateTime.formatIso(DateTime.makeUnsafe(updatedAt)),
    ...overrides,
  }) as OrchestratorMcpThreadListItem;

const listResult = (threads: ReadonlyArray<OrchestratorMcpThreadListItem>) => ({
  projectId: null,
  currentThreadId: null,
  threads,
  nextCursor: null,
  total: threads.length,
});

/** A linked machine as Settings → Linked environments lists it. */
const link = (environmentId: EnvironmentId, label: string, status: PeerLinkStatus = "reachable") =>
  ({ environmentId, label, status }) as PeerLinkSummary;

const setup = (options: {
  readonly local: ReadonlyArray<OrchestrationV2ThreadShell>;
  /** Whether the Linked environments beta is on here. */
  readonly linksEnabled: boolean;
  readonly links?: ReadonlyArray<PeerLinkSummary>;
  readonly remote?: Partial<
    Record<string, Effect.Effect<ReturnType<typeof listResult>, never> | "fail">
  >;
}) => {
  const invoked: string[] = [];
  const layer = VoiceFrontContext.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: options.local,
              archivedThreads: [],
            }),
          getThreadRecords: () => Effect.succeed({ runs: [] } as never),
          getThreadShell: () =>
            Effect.succeed({
              modelSelection: { instanceId: "claude", model: "opus" },
            } as unknown as OrchestrationV2ThreadShell),
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.succeed({ environmentId: here } as ExecutionEnvironmentDescriptor),
        }),
        Layer.mock(PeerLinks.PeerLinks)({
          enabled: Effect.succeed(options.linksEnabled),
          list: Effect.succeed(options.links ?? []),
        }),
        Layer.mock(PeerForwarding.PeerForwarding)({
          call: (scope, tool, environmentId) => {
            invoked.push(`${environmentId}:${tool.name}`);
            // Shift asks as its own thread, the way its tools reach linked machines.
            assert.strictEqual(scope.thread?.threadId, homeThreadId);
            const answer = options.remote?.[environmentId];
            if (answer === undefined || answer === "fail")
              return Effect.die("unexpected or failing environment");
            return answer as never;
          },
        }),
      ),
    ),
  );
  return { layer, invoked };
};

const load = Effect.gen(function* () {
  yield* TestClock.setTime(NOW);
  return yield* (yield* VoiceFrontContext.VoiceFrontContext).load(homeThreadId);
});

it.effect("merges every connected machine's threads, newest first, labeled by machine", () => {
  const { layer, invoked } = setup({
    local: [shell("local-old", 1 * 60_000), shell("local-new", 9 * 60_000)],
    linksEnabled: true,
    links: [link(studio, "Studio")],
    remote: {
      studio: Effect.succeed(
        listResult([
          item("studio-approval", 8 * 60_000, { needs: "approval", status: "waiting" }),
          item("home:studio", 9.5 * 60_000),
          item("studio-old", 2 * 60_000, { status: "completed" }),
        ]),
      ),
    },
  });
  return Effect.gen(function* () {
    const context = yield* load;
    assert.deepStrictEqual(invoked, ["studio:t3_thread_list"]);
    assert.deepStrictEqual(
      context.threads.map((line) => [line.title, line.machine ?? null, line.state]),
      [
        ["local-new", null, "done"],
        ["studio-approval", "Studio", "needs you: waiting for an approval"],
        ["studio-old", "Studio", "done"],
        ["local-old", null, "done"],
      ],
    );
    const text = contextText(context);
    assert.include(text, "Threads on this machine and on Studio, newest first:");
    assert.include(text, `- "local-new" on this machine: done`);
    assert.include(text, `- "studio-approval" on Studio: needs you: waiting for an approval`);
  }).pipe(Effect.provide(layer));
});

it.effect("keeps the merged list to the snapshot limit", () => {
  const { layer } = setup({
    local: Array.from({ length: SNAPSHOT_THREAD_LIMIT }, (_, index) => shell(`l${index}`, index)),
    linksEnabled: true,
    links: [link(studio, "Studio")],
    remote: {
      studio: Effect.succeed(
        listResult(
          Array.from({ length: SNAPSHOT_THREAD_LIMIT }, (_, index) =>
            item(`s${index}`, 1_000 + index),
          ),
        ),
      ),
    },
  });
  return Effect.gen(function* () {
    const context = yield* load;
    assert.strictEqual(context.threads.length, SNAPSHOT_THREAD_LIMIT);
    assert.isTrue(context.threads.every((line) => line.machine === "Studio"));
  }).pipe(Effect.provide(layer));
});

it.effect("answers without a slow, failing, or expired machine and names it", () =>
  Effect.gen(function* () {
    // Tower takes the request and never answers.
    const towerAsked = yield* Deferred.make<void>();
    const { layer, invoked } = setup({
      local: [shell("local", 9 * 60_000)],
      linksEnabled: true,
      links: [
        link(studio, "Studio"),
        link(tower, "Tower"),
        link(EnvironmentId.make("broken"), "Broken"),
        link(EnvironmentId.make("asleep"), "Asleep", "expired"),
      ],
      remote: {
        studio: Effect.succeed(listResult([item("studio", 8 * 60_000)])),
        tower: Deferred.succeed(towerAsked, undefined).pipe(Effect.andThen(Effect.never)),
        broken: "fail",
      },
    });
    yield* TestClock.setTime(NOW);
    const fiber = yield* Effect.forkChild(
      Effect.flatMap(VoiceFrontContext.VoiceFrontContext, (contexts) =>
        contexts.load(homeThreadId),
      ).pipe(Effect.provide(layer)),
    );
    yield* Deferred.await(towerAsked);
    yield* TestClock.adjust(VoiceFrontContext.REMOTE_THREADS_TIMEOUT);
    const context = yield* Fiber.join(fiber);
    // An expired link is not asked at all.
    assert.notInclude(invoked, "asleep:t3_thread_list");
    assert.deepStrictEqual(
      context.threads.map((line) => line.title),
      ["local", "studio"],
    );
    assert.deepStrictEqual(context.machines, ["Studio"]);
    assert.deepStrictEqual(context.unreachable, ["Tower", "Broken", "Asleep"]);
    assert.include(
      contextText(context),
      "Could not reach Tower, Broken and Asleep just now, so threads there are not listed.",
    );
  }),
);

it.effect("lists only this machine, unlabeled, while linked environments are off", () => {
  const { layer, invoked } = setup({
    local: [shell("local", 9 * 60_000)],
    linksEnabled: false,
    links: [link(studio, "Studio")],
  });
  return Effect.gen(function* () {
    const context = yield* load;
    assert.deepStrictEqual(invoked, []);
    assert.deepStrictEqual(context.machines, []);
    assert.deepStrictEqual(context.unreachable, []);
    const text = contextText(context);
    assert.include(text, "Threads, newest first:");
    assert.include(text, `- "local": done`);
  }).pipe(Effect.provide(layer));
});
