import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentThreadGroup,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef, ThreadGroupId, ThreadId } from "@t3tools/contracts";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import { useNavigate } from "@tanstack/react-router";
import { LayersIcon, PencilIcon, PlusIcon, SendIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { canHandOffThread, useThreadGroupActions } from "~/hooks/useThreadGroupActions";
import { cn, newThreadGroupId } from "~/lib/utils";
import {
  type GroupPanelSection,
  type RightPanelSurface,
  useRightPanelStore,
} from "~/rightPanelStore";
import {
  useProject,
  useServerConfigs,
  useThreadShell,
  useThreadShellsForProjectRefs,
} from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { threadGroupCommands, useThreadGroup, useThreadGroups } from "~/state/threadGroups";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { buildThreadRouteParams } from "~/threadRoutes";

import { resolveRenameCommit } from "../chat/ChatHeader";
import { resolveSidebarThreadStatus, resolveThreadGroupStatus } from "../Sidebar.logic";
import { THREAD_HANDOFF_BUSY_HINT } from "../threadActionMenu.logic";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { GroupGlanceCards } from "./GroupGlanceCards";
import { GroupHandoffSection } from "./GroupHandoffSection";
import { GroupInlineEdit } from "./GroupInlineEdit";
import { groupChatSubtitle, groupStatusPill, type GroupStatusPill } from "./GroupPanel.logic";
import { GroupRunningSection } from "./GroupRunningSection";
import { soloGroupView } from "./soloGroupView";
import { useGroupScriptRunner } from "./useGroupScriptRunner";
import { worktreeGroupSuggestion } from "./worktreeGroupSuggestion";

type GroupSurface = Extract<RightPanelSurface, { kind: "group" }>;

/**
 * The Group surface for the routed chat: its visible group, or the chat on its
 * own (with its hidden group's goal, tickets and handoff when it has one).
 */
export function GroupPanel(props: { threadRef: ScopedThreadRef; surface: GroupSurface }) {
  const thread = useThreadShell(props.threadRef);
  const environmentId = thread?.environmentId ?? null;
  const groupId = thread?.groupId ?? null;
  const groupRef = useMemo(
    () => (environmentId === null || groupId === null ? null : { environmentId, groupId }),
    [environmentId, groupId],
  );
  const group = useThreadGroup(groupRef);
  if (thread === null) return null;
  // Keyed so per-panel transient state (script runner, stopped rows, drafts)
  // resets when the panel switches groups or chats instead of leaking across.
  if (group !== null && group.visible) {
    return (
      <GroupPanelContent
        key={`${group.environmentId}:${group.id}`}
        group={group}
        threadRef={props.threadRef}
        surface={props.surface}
      />
    );
  }
  return (
    <SoloPanelContent
      key={`${thread.environmentId}:${thread.id}`}
      thread={thread}
      hiddenGroup={group}
      threadRef={props.threadRef}
      surface={props.surface}
    />
  );
}

/** The project's chats on this environment, by id. */
function useProjectThreadsById(
  environmentId: EnvironmentThreadShell["environmentId"],
  projectId: EnvironmentThreadShell["projectId"],
) {
  const projectRefs = useMemo(() => [{ environmentId, projectId }], [environmentId, projectId]);
  const shells = useThreadShellsForProjectRefs(projectRefs);
  return useMemo(() => {
    const byId = new Map<ThreadId, EnvironmentThreadShell>();
    for (const shell of shells) {
      if (shell.environmentId === environmentId) byId.set(shell.id, shell);
    }
    return byId;
  }, [environmentId, shells]);
}

function useProjectScripts(
  environmentId: EnvironmentThreadShell["environmentId"],
  projectId: EnvironmentThreadShell["projectId"],
) {
  const project = useProject(
    useMemo(() => ({ environmentId, projectId }), [environmentId, projectId]),
  );
  const settings = useEnvironmentSettings(environmentId);
  const scripts = useMemo(
    () => (project === null ? [] : resolveProjectScripts(settings, project)),
    [project, settings],
  );
  return { project, scripts };
}

/** Scrolls to the section an `openGroup` asked for; each call writes a fresh descriptor. */
function useScrollToSection(surface: GroupSurface) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (surface.section === null) return;
    scrollRef.current
      ?.querySelector(`[data-group-section="${surface.section}"]`)
      ?.scrollIntoView({ block: "start" });
  }, [surface]);
  return scrollRef;
}

/** Opens one of the panel's chats with the Group surface kept in view. */
function useOpenPanelChat(environmentId: EnvironmentThreadShell["environmentId"]) {
  const navigate = useNavigate();
  return (threadId: ThreadId) => {
    const ref = scopeThreadRef(environmentId, threadId);
    useRightPanelStore.getState().openGroup(ref);
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
  };
}

function failureToast(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

function GroupPanelContent(props: {
  group: EnvironmentThreadGroup;
  threadRef: ScopedThreadRef;
  surface: GroupSurface;
}) {
  const { group } = props;
  // Members and handoff sources share the group's project, so only that project's
  // chats can change what this panel shows.
  const threadsById = useProjectThreadsById(group.environmentId, group.projectId);
  const members = useMemo(
    () =>
      group.threadIds.flatMap((threadId) => {
        const member = threadsById.get(threadId);
        return member !== undefined && member.archivedAt === null ? [member] : [];
      }),
    [group.threadIds, threadsById],
  );

  // One subscription feeds the Frontend card and the Running section; the server scans while
  // it is read, so it lives exactly as long as the panel shows.
  const resourcesQuery = useEnvironmentQuery(
    useMemo(
      () =>
        threadGroupCommands.resources({ environmentId: group.environmentId, groupId: group.id }),
      [group.environmentId, group.id],
    ),
  );
  const { project, scripts } = useProjectScripts(group.environmentId, group.projectId);
  const resources = resourcesQuery.data?.resources ?? null;
  const runner = useGroupScriptRunner(group, project?.workspaceRoot ?? null, scripts, resources);
  const chatTitles = useMemo(
    () => new Map([...threadsById].map(([id, shell]) => [id, shell.title])),
    [threadsById],
  );
  const scrollRef = useScrollToSection(props.surface);
  const openChat = useOpenPanelChat(group.environmentId);
  const { newChatInGroup, renameGroup } = useThreadGroupActions();
  const updateGroup = useOrchestrationCommand(threadGroupCommands.update, {
    reportFailure: false,
  });
  const currentThread = threadsById.get(props.threadRef.threadId);
  const ensureGroup = async () => group.id;

  const saveGoal = async (goal: string | null) => {
    if (goal === group.goal) return;
    const result = await updateGroup({
      environmentId: group.environmentId,
      input: { groupId: group.id, patch: { goal } },
    });
    failureToast("Failed to update the group goal", result);
  };

  const handoff = group.lastHandoff;
  return (
    <div
      ref={scrollRef}
      className="@container/group-panel flex min-h-0 flex-1 flex-col overflow-y-auto"
    >
      <section data-group-section="header" className="border-border border-b px-4 py-3">
        <PanelHeader
          title={group.title}
          titleLabel="Group title"
          renameLabel="Rename group"
          status={groupStatusPill(resolveThreadGroupStatus(members))}
          goal={group.goal}
          goalLabel="Group goal"
          goalPlaceholder="What is this group working towards?"
          onRename={(draft) => void renameGroup(group, draft)}
          onSaveGoal={(goal) => void saveGoal(goal)}
        />
      </section>
      <section data-group-section="workspace" className="border-border border-b px-2.5 py-3">
        <GroupGlanceCards
          group={group}
          ensureGroup={ensureGroup}
          threadRef={props.threadRef}
          members={members}
          resources={resources}
          scripts={scripts}
          runner={runner}
        />
      </section>
      <GroupSection section="running" title="Running">
        <GroupRunningSection
          group={group}
          ensureGroup={ensureGroup}
          threadRef={props.threadRef}
          resources={resources}
          error={resourcesQuery.error}
          scripts={scripts}
          runner={runner}
          chatTitles={chatTitles}
        />
      </GroupSection>
      <GroupSection section="chats" title={`Chats · ${members.length}`}>
        <ul className="flex flex-col gap-0.5">
          {members.map((member) => (
            <GroupChatRow
              key={member.id}
              member={member}
              currentThreadId={props.threadRef.threadId}
              threadsById={threadsById}
              onOpen={openChat}
            />
          ))}
        </ul>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <Button
            size="xs"
            variant="ghost-muted"
            aria-label="New chat in group"
            onClick={() => void newChatInGroup(group)}
          >
            <PlusIcon aria-hidden />
            <span className="@max-[440px]/group-panel:hidden">New chat in group</span>
            <span className="hidden @max-[440px]/group-panel:inline">New chat</span>
          </Button>
          {currentThread !== undefined ? <HandOffButton thread={currentThread} /> : null}
        </div>
      </GroupSection>
      {handoff !== null ? (
        <GroupSection section="handoff" title="Last handoff">
          <GroupHandoffSection handoff={handoff} group={group} onOpen={openChat} />
        </GroupSection>
      ) : null}
    </div>
  );
}

/**
 * A chat with no visible group, as a group of one: its own title, the hidden
 * group's goal, tickets and handoff when it has one, and a nudge to group the
 * other chats on its worktree. Writes that need a group create the hidden one.
 */
function SoloPanelContent(props: {
  thread: EnvironmentThreadShell;
  hiddenGroup: EnvironmentThreadGroup | null;
  threadRef: ScopedThreadRef;
  surface: GroupSurface;
}) {
  const { thread, hiddenGroup } = props;
  const threadsById = useProjectThreadsById(thread.environmentId, thread.projectId);
  const { project, scripts } = useProjectScripts(thread.environmentId, thread.projectId);
  const workspace = useMemo(
    () => soloGroupView(thread, hiddenGroup, project),
    [hiddenGroup, project, thread],
  );
  const members = useMemo(() => [thread], [thread]);

  // A server before thread-scoped scans only scans groups, so a chat without one shows no Running.
  const scansThreads =
    useServerConfigs().get(thread.environmentId)?.environment.capabilities.threadGroupReorder ===
    true;
  const resourcesAtom = useMemo(
    () =>
      hiddenGroup !== null
        ? threadGroupCommands.resources({
            environmentId: hiddenGroup.environmentId,
            groupId: hiddenGroup.id,
          })
        : scansThreads
          ? threadGroupCommands.resources({
              environmentId: thread.environmentId,
              threadId: thread.id,
            })
          : null,
    [hiddenGroup, scansThreads, thread.environmentId, thread.id],
  );
  const resourcesQuery = useEnvironmentQuery(resourcesAtom);
  const resources = resourcesQuery.data?.resources ?? null;
  const runner = useGroupScriptRunner(
    workspace,
    project?.workspaceRoot ?? null,
    scripts,
    resources,
  );
  const chatTitles = useMemo(() => new Map([[thread.id, thread.title]]), [thread.id, thread.title]);
  const scrollRef = useScrollToSection(props.surface);
  const openChat = useOpenPanelChat(thread.environmentId);

  const createGroup = useOrchestrationCommand(threadGroupCommands.create, {
    reportFailure: false,
  });
  const updateGroup = useOrchestrationCommand(threadGroupCommands.update, {
    reportFailure: false,
  });
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const { moveThreadIntoGroup } = useThreadGroupActions();

  /**
   * Creates the hidden group with this chat first, so it keeps this chat's
   * workspace and title. Every solo create goes through the one in-flight
   * promise: a second create would move the chat out of the first group, and
   * the prune would drop that group with whatever was just written to it.
   */
  const pendingCreate = useRef<Promise<ThreadGroupId | null> | null>(null);
  // Once the group shows up it is the source of truth; a stale id must not outlive it.
  useEffect(() => {
    if (hiddenGroup !== null) pendingCreate.current = null;
  }, [hiddenGroup]);
  const createOnce = (
    input: { readonly threadIds?: ReadonlyArray<ThreadId>; readonly goal?: string },
    failure: string,
  ) => {
    const groupId = newThreadGroupId();
    const pending = createGroup({
      environmentId: thread.environmentId,
      input: {
        groupId,
        projectId: thread.projectId,
        threadIds: [thread.id, ...(input.threadIds ?? [])],
        ...(input.goal === undefined ? {} : { goal: input.goal }),
      },
    }).then((result) => {
      failureToast(failure, result);
      if (result._tag === "Success") return groupId;
      if (pendingCreate.current === pending) pendingCreate.current = null;
      return null;
    });
    pendingCreate.current = pending;
    return pending;
  };
  /** The group a write should land in: one being created, the hidden one, or a new one. */
  const ensureGroup = () =>
    pendingCreate.current ??
    (hiddenGroup !== null
      ? Promise.resolve(hiddenGroup.id)
      : createOnce({}, "Failed to create the group"));

  const rename = async (draft: string) => {
    const resolution = resolveRenameCommit({ title: draft, originalTitle: thread.title });
    if (resolution.action === "reject-empty") {
      toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
      return;
    }
    if (resolution.action === "noop") return;
    const result = await updateThreadMetadata({
      environmentId: thread.environmentId,
      input: { threadId: thread.id, title: resolution.title },
    });
    failureToast("Failed to rename thread", result);
  };

  const saveGoal = async (goal: string | null) => {
    const pending = pendingCreate.current;
    if (pending === null && hiddenGroup === null) {
      // The server names the new group from this chat, then from the goal.
      if (goal !== null) await createOnce({ goal }, "Failed to set the goal");
      return;
    }
    const groupId = pending !== null ? await pending : (hiddenGroup?.id ?? null);
    if (groupId === null) return;
    if (pending === null && goal === hiddenGroup?.goal) return;
    const result = await updateGroup({
      environmentId: thread.environmentId,
      input: { groupId, patch: { goal } },
    });
    failureToast("Failed to update the goal", result);
  };

  const groupsById = useThreadGroupsById(thread.environmentId);
  const suggestedIds = useMemo(
    () =>
      worktreeGroupSuggestion(
        thread,
        [...threadsById.values()],
        groupsById,
        project?.workspaceRoot ?? null,
      ),
    [groupsById, project?.workspaceRoot, thread, threadsById],
  );
  const [grouping, setGrouping] = useState(false);
  const groupSuggested = async () => {
    setGrouping(true);
    try {
      const pending = pendingCreate.current;
      if (pending === null && hiddenGroup === null) {
        await createOnce({ threadIds: suggestedIds }, "Failed to create group");
        return;
      }
      const groupId = pending !== null ? await pending : (hiddenGroup?.id ?? null);
      if (groupId === null) return;
      // A group made from this chat has this chat's title and workspace until it loads.
      const target = {
        id: groupId,
        title: hiddenGroup?.title ?? thread.title,
        branch: workspace.branch,
        worktreePath: workspace.worktreePath,
      };
      for (const threadId of suggestedIds) {
        const other = threadsById.get(threadId);
        if (other !== undefined) await moveThreadIntoGroup(other, target);
      }
    } finally {
      setGrouping(false);
    }
  };

  const handoff = hiddenGroup?.lastHandoff ?? null;
  return (
    <div
      ref={scrollRef}
      className="@container/group-panel flex min-h-0 flex-1 flex-col overflow-y-auto"
    >
      <section data-group-section="header" className="border-border border-b px-4 py-3">
        <PanelHeader
          title={thread.title}
          titleLabel="Chat title"
          renameLabel="Rename chat"
          status={groupStatusPill(resolveThreadGroupStatus(members))}
          goal={hiddenGroup?.goal ?? null}
          goalLabel="Chat goal"
          goalPlaceholder="What is this chat working towards?"
          onRename={(draft) => void rename(draft)}
          onSaveGoal={(goal) => void saveGoal(goal)}
        />
      </section>
      <section data-group-section="workspace" className="border-border border-b px-2.5 py-3">
        <GroupGlanceCards
          group={workspace}
          ensureGroup={ensureGroup}
          threadRef={props.threadRef}
          members={members}
          resources={resources}
          scripts={scripts}
          runner={runner}
        />
      </section>
      {resourcesAtom !== null ? (
        <GroupSection section="running" title="Running">
          <GroupRunningSection
            group={{
              id: workspace.id,
              environmentId: thread.environmentId,
              manualResources: hiddenGroup?.manualResources ?? [],
            }}
            ensureGroup={ensureGroup}
            threadRef={props.threadRef}
            resources={resources}
            error={resourcesQuery.error}
            scripts={scripts}
            runner={runner}
            chatTitles={chatTitles}
          />
        </GroupSection>
      ) : null}
      <GroupSection section="chats" title="Chats · 1">
        <ul className="flex flex-col gap-0.5">
          <GroupChatRow
            member={thread}
            currentThreadId={thread.id}
            threadsById={threadsById}
            onOpen={openChat}
          />
        </ul>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <HandOffButton thread={thread} />
        </div>
        {suggestedIds.length > 0 ? (
          <p className="mt-1.5 flex flex-wrap items-center gap-1 px-1.5 text-muted-foreground text-xs">
            {suggestedIds.length === 1
              ? "1 other chat uses this worktree"
              : `${suggestedIds.length} other chats use this worktree`}
            <span aria-hidden>·</span>
            <Button
              size="xs"
              variant="link"
              disabled={grouping}
              onClick={() => void groupSuggested()}
            >
              Group them
            </Button>
          </p>
        ) : null}
      </GroupSection>
      {handoff !== null && hiddenGroup !== null ? (
        <GroupSection section="handoff" title="Last handoff">
          <GroupHandoffSection handoff={handoff} group={hiddenGroup} onOpen={openChat} />
        </GroupSection>
      ) : null}
    </div>
  );
}

/** The environment's groups by id, for telling visible groups from hidden ones. */
function useThreadGroupsById(environmentId: EnvironmentThreadShell["environmentId"]) {
  const groups = useThreadGroups();
  return useMemo(
    () =>
      new Map(
        groups.flatMap((group) =>
          group.environmentId === environmentId ? [[group.id, group] as const] : [],
        ),
      ),
    [environmentId, groups],
  );
}

function HandOffButton(props: { thread: EnvironmentThreadShell }) {
  const { handOffThread } = useThreadGroupActions();
  const canHandOff = canHandOffThread(props.thread);
  return (
    <Tooltip disabled={canHandOff}>
      {/* A disabled button takes no pointer events, so the wrapper carries the tooltip. */}
      <TooltipTrigger render={<span className="inline-flex" />}>
        <Button
          size="xs"
          variant="ghost-muted"
          aria-label="Hand off to new chat"
          disabled={!canHandOff}
          onClick={() => void handOffThread(props.thread)}
        >
          <SendIcon aria-hidden />
          <span className="@max-[440px]/group-panel:hidden">Hand off to new chat</span>
          <span className="hidden @max-[440px]/group-panel:inline">Hand off</span>
        </Button>
      </TooltipTrigger>
      <TooltipPopup>{THREAD_HANDOFF_BUSY_HINT}</TooltipPopup>
    </Tooltip>
  );
}

function GroupSection(props: { section: GroupPanelSection; title: string; children: ReactNode }) {
  return (
    <section
      data-group-section={props.section}
      className="border-border border-b px-2.5 py-3 last:border-b-0"
    >
      <h3 className="mb-1.5 px-1.5 font-medium text-2xs text-muted-foreground uppercase tracking-wide">
        {props.title}
      </h3>
      {props.children}
    </section>
  );
}

function StatusPill(props: { pill: GroupStatusPill }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-sm bg-accent px-1.5 py-px font-medium text-2xs",
        props.pill.colorClass,
      )}
    >
      {props.pill.label}
    </span>
  );
}

/** Title and goal; edits commit through the callbacks, which own their failures. */
function PanelHeader(props: {
  title: string;
  titleLabel: string;
  renameLabel: string;
  status: GroupStatusPill | null;
  goal: string | null;
  goalLabel: string;
  goalPlaceholder: string;
  onRename: (draft: string) => void;
  onSaveGoal: (goal: string | null) => void;
}) {
  const [editing, setEditing] = useState<"title" | "goal" | null>(null);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <LayersIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        {editing === "title" ? (
          <GroupInlineEdit
            label={props.titleLabel}
            initial={props.title}
            className="font-semibold text-base"
            onCommit={(draft) => {
              setEditing(null);
              props.onRename(draft);
            }}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <h2
            className="min-w-0 flex-1 truncate font-semibold text-base text-foreground"
            onDoubleClick={() => setEditing("title")}
          >
            {props.title}
          </h2>
        )}
        {props.status !== null ? <StatusPill pill={props.status} /> : null}
        {editing === null ? (
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={props.renameLabel}
            onClick={() => setEditing("title")}
          >
            <PencilIcon />
          </Button>
        ) : null}
      </div>
      {editing === "goal" ? (
        <GroupInlineEdit
          label={props.goalLabel}
          initial={props.goal ?? ""}
          placeholder={props.goalPlaceholder}
          className="text-sm"
          onCommit={(draft) => {
            setEditing(null);
            props.onSaveGoal(draft.trim() === "" ? null : draft.trim());
          }}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <button
          type="button"
          className={cn(
            "cursor-text rounded-sm text-left text-sm",
            props.goal === null ? "text-muted-foreground/70" : "text-muted-foreground",
          )}
          onClick={() => setEditing("goal")}
        >
          {props.goal ?? "Add a goal"}
        </button>
      )}
    </div>
  );
}

function GroupChatRow(props: {
  member: EnvironmentThreadShell;
  currentThreadId: ThreadId;
  threadsById: ReadonlyMap<ThreadId, EnvironmentThreadShell>;
  onOpen: (threadId: ThreadId) => void;
}) {
  const { member } = props;
  const status = resolveSidebarThreadStatus(member);
  const pill = groupStatusPill(status);
  const current = member.id === props.currentThreadId;
  const subtitle = groupChatSubtitle({
    thread: member,
    currentThreadId: props.currentThreadId,
    threadsById: props.threadsById,
    status,
  });
  return (
    <li className="list-none">
      <button
        type="button"
        aria-current={current ? "page" : undefined}
        className={cn(
          "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent/60",
          current && "bg-accent",
        )}
        onClick={() => props.onOpen(member.id)}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            className={cn(
              "truncate text-sm",
              member.handedOffTo !== null && !current ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {member.title}
          </span>
          <span className="truncate text-muted-foreground text-xs">{subtitle}</span>
        </span>
        {pill !== null ? <StatusPill pill={pill} /> : null}
      </button>
    </li>
  );
}
