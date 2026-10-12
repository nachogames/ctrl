import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadGroupId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadGroupStore from "./ThreadGroupStore.ts";
import {
  projectCreatedEvent,
  projectDeletedEvent,
  pullRequestLink,
  sequenced,
  threadGroupCreatedEvent,
  threadGroupDeletedEvent,
  threadGroupMetaUpdatedEvent,
} from "./testkit/threadGroupFixtures.ts";

it.layer(
  Layer.mergeAll(ThreadGroupStore.layer, ProjectStore.layer).pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
  ),
)("ThreadGroupStoreV2", (it) => {
  it.effect("folds partial updates, clearing only fields sent as null", () =>
    Effect.gen(function* () {
      const groups = yield* ThreadGroupStore.ThreadGroupStoreV2;
      const projects = yield* ProjectStore.ProjectStoreV2;
      const projectId = ProjectId.make("project:group-store:fold");
      const groupId = ThreadGroupId.make("group:store:fold");
      const resource = { id: "api", name: "Staging API", url: null, kind: "server" as const };
      const link = {
        id: "link:1",
        url: "https://github.com/t3tools/t3code/issues/88",
        label: "#88",
      };
      yield* projects.apply(projectCreatedEvent(projectId));
      yield* groups.apply(
        sequenced(threadGroupCreatedEvent({ groupId, projectId, pullRequest: pullRequestLink }), 2),
      );
      yield* groups.apply(
        sequenced(
          threadGroupMetaUpdatedEvent(groupId, {
            goal: "Ship the sidebar.",
            manualResources: [resource],
            links: [link],
          }),
          3,
        ),
      );
      yield* groups.apply(
        sequenced(
          threadGroupMetaUpdatedEvent(
            groupId,
            { goal: null, pinnedAt: "2026-10-10T04:00:00.000Z" },
            "2026-10-10T04:00:00.000Z",
          ),
          4,
        ),
      );

      const shell = Option.getOrThrow(yield* groups.getShell(groupId));
      assert.deepStrictEqual(
        {
          title: shell.title,
          goal: shell.goal,
          branch: shell.branch,
          pullRequest: shell.pullRequest,
          pinnedAt: shell.pinnedAt,
          manualResources: shell.manualResources,
          links: shell.links,
          updatedAt: shell.updatedAt,
        },
        {
          title: "Auth refactor",
          goal: null,
          branch: "feat/auth-refactor",
          pullRequest: pullRequestLink,
          pinnedAt: "2026-10-10T04:00:00.000Z",
          manualResources: [resource],
          links: [link],
          updatedAt: "2026-10-10T04:00:00.000Z",
        },
      );
    }),
  );

  it.effect("hides deleted groups and groups of deleted projects from shells", () =>
    Effect.gen(function* () {
      const groups = yield* ThreadGroupStore.ThreadGroupStoreV2;
      const projects = yield* ProjectStore.ProjectStoreV2;
      const liveProject = ProjectId.make("project:group-store:live");
      const goneProject = ProjectId.make("project:group-store:gone");
      const kept = ThreadGroupId.make("group:store:kept");
      const deleted = ThreadGroupId.make("group:store:deleted");
      const orphaned = ThreadGroupId.make("group:store:orphaned");
      yield* projects.apply(projectCreatedEvent(liveProject, 10));
      yield* projects.apply(projectCreatedEvent(goneProject, 11));
      yield* groups.apply(
        sequenced(threadGroupCreatedEvent({ groupId: kept, projectId: liveProject }), 12),
      );
      yield* groups.apply(
        sequenced(threadGroupCreatedEvent({ groupId: deleted, projectId: liveProject }), 13),
      );
      yield* groups.apply(
        sequenced(threadGroupCreatedEvent({ groupId: orphaned, projectId: goneProject }), 14),
      );
      yield* groups.apply(sequenced(threadGroupDeletedEvent(deleted), 15));
      yield* projects.apply(projectDeletedEvent(goneProject, 16));

      const shells = yield* groups.listShells({ projectIds: [liveProject, goneProject] });
      assert.deepEqual(
        shells.map((shell) => shell.id),
        [kept],
      );
      assert.isTrue(Option.isNone(yield* groups.getShell(deleted)));
      assert.isTrue(Option.isNone(yield* groups.get(deleted)));
      assert.isNotNull(
        Option.getOrThrow(yield* groups.get(deleted, { includeDeleted: true })).deletedAt,
      );
      assert.isTrue(Option.isNone(yield* groups.getShell(orphaned)));
    }),
  );
});
