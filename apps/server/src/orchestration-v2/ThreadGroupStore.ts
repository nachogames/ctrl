import {
  type ApplicationThreadGroupEvent,
  IsoDateTime,
  type OrchestrationThreadGroupShell,
  ProjectId,
  ThreadGroupHandoff,
  ThreadGroupId,
  ThreadGroupLink,
  ThreadGroupManualResource,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

export class ThreadGroupStoreV2Error extends Schema.TaggedError<ThreadGroupStoreV2Error>()(
  "ThreadGroupStoreV2Error",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread group store operation '${this.operation}' failed.`;
  }
}

/** One row of `projection_thread_groups`, the durable thread group read model. */
export const ThreadGroupRow = Schema.Struct({
  groupId: ThreadGroupId,
  projectId: ProjectId,
  title: Schema.String,
  goal: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  pullRequest: Schema.NullOr(ThreadPullRequestLink),
  lastHandoff: Schema.NullOr(ThreadGroupHandoff),
  pinnedAt: Schema.NullOr(IsoDateTime),
  snoozedUntil: Schema.NullOr(IsoDateTime),
  settledAt: Schema.NullOr(IsoDateTime),
  manualResources: Schema.Array(ThreadGroupManualResource),
  links: Schema.Array(ThreadGroupLink),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ThreadGroupRow = typeof ThreadGroupRow.Type;

const ThreadGroupDbRow = Schema.Struct({
  ...ThreadGroupRow.fields,
  pullRequest: Schema.NullOr(Schema.fromJsonString(ThreadPullRequestLink)),
  lastHandoff: Schema.NullOr(Schema.fromJsonString(ThreadGroupHandoff)),
  manualResources: Schema.fromJsonString(Schema.Array(ThreadGroupManualResource)),
  links: Schema.fromJsonString(Schema.Array(ThreadGroupLink)),
});

function toShell(row: ThreadGroupRow): OrchestrationThreadGroupShell {
  return {
    id: row.groupId,
    projectId: row.projectId,
    title: row.title,
    goal: row.goal,
    branch: row.branch,
    worktreePath: row.worktreePath,
    pullRequest: row.pullRequest,
    lastHandoff: row.lastHandoff,
    pinnedAt: row.pinnedAt,
    snoozedUntil: row.snoozedUntil,
    settledAt: row.settledAt,
    manualResources: row.manualResources,
    links: row.links,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class ThreadGroupStoreV2 extends Context.Service<
  ThreadGroupStoreV2,
  {
    /** Fold one committed group event into its row. Call inside the commit transaction. */
    readonly apply: (
      event: ApplicationThreadGroupEvent,
    ) => Effect.Effect<void, ThreadGroupStoreV2Error>;
    readonly get: (
      groupId: ThreadGroupId,
      options?: { readonly includeDeleted?: boolean },
    ) => Effect.Effect<Option.Option<ThreadGroupRow>, ThreadGroupStoreV2Error>;
    readonly list: (options?: {
      readonly projectIds?: ReadonlyArray<ProjectId>;
      readonly includeDeleted?: boolean;
    }) => Effect.Effect<ReadonlyArray<ThreadGroupRow>, ThreadGroupStoreV2Error>;
    /** A live group's shell; none when the group or its project is deleted. */
    readonly getShell: (
      groupId: ThreadGroupId,
    ) => Effect.Effect<Option.Option<OrchestrationThreadGroupShell>, ThreadGroupStoreV2Error>;
    /** Live group shells of live projects, in creation order. */
    readonly listShells: (options?: {
      readonly projectIds?: ReadonlyArray<ProjectId>;
    }) => Effect.Effect<ReadonlyArray<OrchestrationThreadGroupShell>, ThreadGroupStoreV2Error>;
  }
>()("t3/orchestration-v2/ThreadGroupStore/ThreadGroupStoreV2") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const encodeRow = Schema.encodeEffect(ThreadGroupDbRow);

  const selectRows = SqlSchema.findAll({
    Request: Schema.Struct({
      groupId: Schema.optional(ThreadGroupId),
      projectIds: Schema.optional(Schema.Array(ProjectId)),
      includeDeleted: Schema.Boolean,
      liveProjectsOnly: Schema.Boolean,
    }),
    Result: ThreadGroupDbRow,
    execute: (request) => sql`
      SELECT
        group_id AS "groupId",
        project_id AS "projectId",
        title,
        goal,
        branch,
        worktree_path AS "worktreePath",
        pull_request_json AS "pullRequest",
        last_handoff_json AS "lastHandoff",
        pinned_at AS "pinnedAt",
        snoozed_until AS "snoozedUntil",
        settled_at AS "settledAt",
        manual_resources_json AS "manualResources",
        links_json AS "links",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        deleted_at AS "deletedAt"
      FROM projection_thread_groups
      WHERE ${sql.and([
        ...(request.includeDeleted ? [] : [sql`deleted_at IS NULL`]),
        ...(request.groupId === undefined ? [] : [sql`group_id = ${request.groupId}`]),
        ...(request.projectIds === undefined ? [] : [sql.in("project_id", request.projectIds)]),
        ...(request.liveProjectsOnly
          ? [
              sql`project_id IN (
                SELECT project_id FROM projection_projects WHERE deleted_at IS NULL
              )`,
            ]
          : []),
      ])}
      ORDER BY created_at ASC, group_id ASC
    `,
  });

  const upsertRow = (row: ThreadGroupRow) =>
    encodeRow(row).pipe(
      Effect.flatMap(
        (encoded) => sql`
          INSERT INTO projection_thread_groups (
            group_id,
            project_id,
            title,
            goal,
            branch,
            worktree_path,
            pull_request_json,
            last_handoff_json,
            pinned_at,
            snoozed_until,
            settled_at,
            manual_resources_json,
            links_json,
            created_at,
            updated_at,
            deleted_at
          )
          VALUES (
            ${encoded.groupId},
            ${encoded.projectId},
            ${encoded.title},
            ${encoded.goal},
            ${encoded.branch},
            ${encoded.worktreePath},
            ${encoded.pullRequest},
            ${encoded.lastHandoff},
            ${encoded.pinnedAt},
            ${encoded.snoozedUntil},
            ${encoded.settledAt},
            ${encoded.manualResources},
            ${encoded.links},
            ${encoded.createdAt},
            ${encoded.updatedAt},
            ${encoded.deletedAt}
          )
          ON CONFLICT (group_id)
          DO UPDATE SET
            project_id = excluded.project_id,
            title = excluded.title,
            goal = excluded.goal,
            branch = excluded.branch,
            worktree_path = excluded.worktree_path,
            pull_request_json = excluded.pull_request_json,
            last_handoff_json = excluded.last_handoff_json,
            pinned_at = excluded.pinned_at,
            snoozed_until = excluded.snoozed_until,
            settled_at = excluded.settled_at,
            manual_resources_json = excluded.manual_resources_json,
            links_json = excluded.links_json,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            deleted_at = excluded.deleted_at
        `,
      ),
    );

  const mapError =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => new ThreadGroupStoreV2Error({ operation, cause })));

  const get: ThreadGroupStoreV2["Service"]["get"] = (groupId, options) =>
    selectRows({
      groupId,
      includeDeleted: options?.includeDeleted === true,
      liveProjectsOnly: false,
    }).pipe(
      Effect.map((rows) => Option.fromUndefinedOr(rows[0])),
      mapError("get"),
    );

  const list: ThreadGroupStoreV2["Service"]["list"] = (options) =>
    selectRows({
      ...(options?.projectIds === undefined ? {} : { projectIds: options.projectIds }),
      includeDeleted: options?.includeDeleted === true,
      liveProjectsOnly: false,
    }).pipe(mapError("list"));

  const apply: ThreadGroupStoreV2["Service"]["apply"] = Effect.fn("ThreadGroupStoreV2.apply")(
    function* (event) {
      if (event.type === "thread-group.created") {
        const payload = event.payload;
        return yield* upsertRow({
          groupId: payload.groupId,
          projectId: payload.projectId,
          title: payload.title,
          goal: payload.goal,
          branch: payload.branch,
          worktreePath: payload.worktreePath,
          pullRequest: payload.pullRequest,
          lastHandoff: null,
          pinnedAt: null,
          snoozedUntil: null,
          settledAt: null,
          manualResources: [],
          links: [],
          createdAt: payload.createdAt,
          updatedAt: payload.updatedAt,
          deletedAt: null,
        }).pipe(mapError("apply"));
      }
      const existing = yield* get(event.payload.groupId, { includeDeleted: true });
      if (Option.isNone(existing)) return;
      const row = existing.value;
      if (event.type === "thread-group.deleted") {
        return yield* upsertRow({
          ...row,
          deletedAt: event.payload.deletedAt,
          updatedAt: event.payload.deletedAt,
        }).pipe(mapError("apply"));
      }
      const patch = event.payload;
      yield* upsertRow({
        ...row,
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.goal === undefined ? {} : { goal: patch.goal }),
        ...(patch.branch === undefined ? {} : { branch: patch.branch }),
        ...(patch.worktreePath === undefined ? {} : { worktreePath: patch.worktreePath }),
        ...(patch.pullRequest === undefined ? {} : { pullRequest: patch.pullRequest }),
        ...(patch.lastHandoff === undefined ? {} : { lastHandoff: patch.lastHandoff }),
        ...(patch.pinnedAt === undefined ? {} : { pinnedAt: patch.pinnedAt }),
        ...(patch.snoozedUntil === undefined ? {} : { snoozedUntil: patch.snoozedUntil }),
        ...(patch.settledAt === undefined ? {} : { settledAt: patch.settledAt }),
        ...(patch.manualResources === undefined ? {} : { manualResources: patch.manualResources }),
        ...(patch.links === undefined ? {} : { links: patch.links }),
        updatedAt: patch.updatedAt,
      }).pipe(mapError("apply"));
    },
  );

  return ThreadGroupStoreV2.of({
    apply,
    get,
    list,
    getShell: (groupId) =>
      selectRows({ groupId, includeDeleted: false, liveProjectsOnly: true }).pipe(
        Effect.map((rows) => Option.map(Option.fromUndefinedOr(rows[0]), toShell)),
        mapError("getShell"),
      ),
    listShells: (options) =>
      selectRows({
        ...(options?.projectIds === undefined ? {} : { projectIds: options.projectIds }),
        includeDeleted: false,
        liveProjectsOnly: true,
      }).pipe(
        Effect.map((rows) => rows.map(toShell)),
        mapError("listShells"),
      ),
  });
});

export const layer = Layer.effect(ThreadGroupStoreV2, make);
