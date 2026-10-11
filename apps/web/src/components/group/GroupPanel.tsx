import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentThreadGroup,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { LayersIcon, PencilIcon } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import { useThreadGroupActions } from "~/hooks/useThreadGroupActions";
import { cn } from "~/lib/utils";
import {
  type GroupPanelSection,
  type RightPanelSurface,
  useRightPanelStore,
} from "~/rightPanelStore";
import { useThreadShell, useThreadShellsForProjectRefs } from "~/state/entities";
import { threadGroupCommands, useThreadGroup } from "~/state/threadGroups";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { buildThreadRouteParams } from "~/threadRoutes";

import { resolveSidebarThreadStatus, resolveThreadGroupStatus } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  groupChatSubtitle,
  groupStatusPill,
  splitInlineCode,
  type GroupStatusPill,
} from "./GroupPanel.logic";
import { GroupRunningSection } from "./GroupRunningSection";
import { GroupWorkspaceSection } from "./GroupWorkspaceSection";

type GroupSurface = Extract<RightPanelSurface, { kind: "group" }>;

/**
 * The Group surface: the routed chat's group header, workspace, chats and
 * last handoff. Renders an explanation when the chat is not in a known group.
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
  // Shells load before groups are known; stay blank rather than flash the hint.
  if (thread === null) return null;
  if (group === null) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-muted-foreground text-sm">
        Only chats in a group have a Group panel.
      </div>
    );
  }
  return <GroupPanelContent group={group} threadRef={props.threadRef} surface={props.surface} />;
}

function GroupPanelContent(props: {
  group: EnvironmentThreadGroup;
  threadRef: ScopedThreadRef;
  surface: GroupSurface;
}) {
  const { group } = props;
  // Members and handoff sources share the group's project, so only that project's
  // chats can change what this panel shows.
  const projectRefs = useMemo(
    () => [{ environmentId: group.environmentId, projectId: group.projectId }],
    [group.environmentId, group.projectId],
  );
  const shells = useThreadShellsForProjectRefs(projectRefs);
  const threadsById = useMemo(() => {
    const byId = new Map<ThreadId, EnvironmentThreadShell>();
    for (const shell of shells) {
      if (shell.environmentId === group.environmentId) byId.set(shell.id, shell);
    }
    return byId;
  }, [group.environmentId, shells]);
  const members = useMemo(
    () =>
      group.threadIds.flatMap((threadId) => {
        const member = threadsById.get(threadId);
        return member !== undefined && member.archivedAt === null ? [member] : [];
      }),
    [group.threadIds, threadsById],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  // Each `openGroup` writes a fresh descriptor, so this runs once per request.
  useEffect(() => {
    if (props.surface.section === null) return;
    scrollRef.current
      ?.querySelector(`[data-group-section="${props.surface.section}"]`)
      ?.scrollIntoView({ block: "start" });
  }, [props.surface]);

  const navigate = useNavigate();
  const openChat = (threadId: ThreadId) => {
    const ref = scopeThreadRef(group.environmentId, threadId);
    // Moving between a group's chats keeps the group in view.
    useRightPanelStore.getState().openGroup(ref);
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
  };

  const handoff = group.lastHandoff;
  return (
    <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <section data-group-section="header" className="border-border border-b px-4 py-3">
        <GroupHeader group={group} status={groupStatusPill(resolveThreadGroupStatus(members))} />
      </section>
      <GroupSection section="workspace" title="Workspace">
        <GroupWorkspaceSection group={group} threadRef={props.threadRef} />
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
      </GroupSection>
      <GroupSection section="running" title="Running">
        <GroupRunningSection group={group} threadRef={props.threadRef} />
      </GroupSection>
      {handoff !== null ? (
        <GroupSection section="handoff" title="Last handoff">
          <p className="px-1.5 text-sm leading-relaxed whitespace-pre-wrap text-foreground">
            {splitInlineCode(handoff.summary).map((segment) =>
              segment.code ? (
                <code key={segment.start} className="font-mono">
                  {segment.text}
                </code>
              ) : (
                <span key={segment.start}>{segment.text}</span>
              ),
            )}
          </p>
          <HandoffSourceLink threadId={handoff.fromThreadId} group={group} onOpen={openChat} />
        </GroupSection>
      ) : null}
    </div>
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

function GroupHeader(props: { group: EnvironmentThreadGroup; status: GroupStatusPill | null }) {
  const { group } = props;
  const { renameGroup } = useThreadGroupActions();
  const updateGroup = useOrchestrationCommand(threadGroupCommands.update, {
    reportFailure: false,
  });
  const [editing, setEditing] = useState<"title" | "goal" | null>(null);

  const saveGoal = async (draft: string) => {
    setEditing(null);
    const goal = draft.trim() === "" ? null : draft.trim();
    if (goal === group.goal) return;
    const result = await updateGroup({
      environmentId: group.environmentId,
      input: { groupId: group.id, patch: { goal } },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to update the group goal",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <LayersIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        {editing === "title" ? (
          <InlineEdit
            label="Group title"
            initial={group.title}
            className="font-semibold text-base"
            onCommit={(draft) => {
              setEditing(null);
              void renameGroup(group, draft);
            }}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <h2
            className="min-w-0 flex-1 truncate font-semibold text-base text-foreground"
            onDoubleClick={() => setEditing("title")}
          >
            {group.title}
          </h2>
        )}
        {props.status !== null ? <StatusPill pill={props.status} /> : null}
        {editing === null ? (
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Rename group"
            onClick={() => setEditing("title")}
          >
            <PencilIcon />
          </Button>
        ) : null}
      </div>
      {editing === "goal" ? (
        <InlineEdit
          label="Group goal"
          initial={group.goal ?? ""}
          placeholder="What is this group working towards?"
          className="text-sm"
          onCommit={(draft) => void saveGoal(draft)}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <button
          type="button"
          className={cn(
            "cursor-text rounded-sm text-left text-sm",
            group.goal === null ? "text-muted-foreground/70" : "text-muted-foreground",
          )}
          onClick={() => setEditing("goal")}
        >
          {group.goal ?? "Add a goal"}
        </button>
      )}
    </div>
  );
}

/** Enter (or blur) saves, Escape cancels; mounted only while editing. */
function InlineEdit(props: {
  label: string;
  initial: string;
  placeholder?: string;
  className: string;
  onCommit: (draft: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(props.initial);
  const doneRef = useRef(false);
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      doneRef.current = true;
      props.onCommit(draft);
    } else if (event.key === "Escape") {
      event.preventDefault();
      doneRef.current = true;
      props.onCancel();
    }
  };
  return (
    <input
      autoFocus
      value={draft}
      aria-label={props.label}
      placeholder={props.placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={handleKeyDown}
      onBlur={() => {
        if (!doneRef.current) props.onCommit(draft);
      }}
      className={cn(
        "min-w-0 flex-1 rounded-sm border border-input bg-card px-1 text-card-foreground outline-none focus:border-foreground",
        props.className,
      )}
    />
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

function HandoffSourceLink(props: {
  threadId: ThreadId;
  group: EnvironmentThreadGroup;
  onOpen: (threadId: ThreadId) => void;
}) {
  const source = useThreadShell(
    useMemo(
      () => scopeThreadRef(props.group.environmentId, props.threadId),
      [props.group.environmentId, props.threadId],
    ),
  );
  if (source === null || source.deletedAt !== null) return null;
  return (
    <p className="mt-2 px-1.5 text-muted-foreground text-xs">
      from{" "}
      <button
        type="button"
        className="cursor-pointer text-foreground underline-offset-2 hover:underline"
        onClick={() => props.onOpen(props.threadId)}
      >
        {source.title}
      </button>
    </p>
  );
}
