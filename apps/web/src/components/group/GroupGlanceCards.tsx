import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type ProjectScript,
  type ScopedThreadRef,
  type ThreadGroupId,
  type ThreadGroupLink,
  type ThreadGroupRunningResource,
} from "@t3tools/contracts";
import { groupLinkLabel } from "@t3tools/shared/threadGroups";
import { useNavigate } from "@tanstack/react-router";
import {
  ActivityIcon,
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  FolderIcon,
  FolderOpenIcon,
  GitBranchIcon,
  MonitorIcon,
  PlayIcon,
  PlusIcon,
  TicketIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { isElectron } from "~/env";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useThreadGroupActions } from "~/hooks/useThreadGroupActions";
import { cn, randomUUID } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { useProject } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { shellEnvironment } from "~/state/shell";
import { threadGroupCommands } from "~/state/threadGroups";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { vcsEnvironment } from "~/state/vcs";

import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { resolveSidebarThreadStatus, sidebarActivityMs } from "../Sidebar.logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { MiddleTruncate } from "../ui/middle-truncate";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  compactTicketChips,
  frontendScript,
  glanceCards,
  glanceFrontend,
  groupActivity,
  ticketChips,
  type GlanceCard,
  type GlanceTone,
  type TicketChip,
} from "./GroupGlanceCards.logic";
import type { GroupWorkspaceSource } from "./soloGroupView";
import { useGroupPullRequestStatus } from "./useGroupPullRequestStatus";
import type { GroupScriptRunner } from "./useGroupScriptRunner";
import { useOpenServerUrl } from "./useOpenServerUrl";

const TONE_CLASS: Record<GlanceTone, string> = {
  default: "text-foreground",
  muted: "text-muted-foreground",
  success: "text-success-foreground",
  warning: "text-warning-foreground",
  merged: "text-violet-600 dark:text-violet-300",
};

const CARD_ICON: Record<GlanceCard["id"], LucideIcon> = {
  branch: GitBranchIcon,
  "pull-request": PullRequestGlyph.pullRequest,
  tickets: TicketIcon,
  frontend: MonitorIcon,
  worktree: FolderIcon,
  activity: ActivityIcon,
};

function errorToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/**
 * The group at a glance: branch, pull request, tickets, frontend, worktree and
 * activity. Two columns of cards at 440px and wider, one six-row card below,
 * switched by the `group-panel` container query. A solo chat passes its
 * `soloGroupView`; `ensureGroup` creates its hidden group when a link needs one.
 */
export function GroupGlanceCards(props: {
  group: GroupWorkspaceSource;
  ensureGroup: () => Promise<ThreadGroupId | null>;
  threadRef: ScopedThreadRef;
  members: ReadonlyArray<EnvironmentThreadShell>;
  resources: ReadonlyArray<ThreadGroupRunningResource> | null;
  scripts: ReadonlyArray<ProjectScript>;
  runner: GroupScriptRunner;
}) {
  const { group, runner } = props;
  const project = useProject(
    useMemo(
      () => ({ environmentId: group.environmentId, projectId: group.projectId }),
      [group.environmentId, group.projectId],
    ),
  );
  const cwd = group.worktreePath ?? project?.workspaceRoot ?? null;
  const status = useEnvironmentQuery(
    cwd === null
      ? null
      : vcsEnvironment.status({
          environmentId: group.environmentId,
          input: { cwd, includeRemote: false },
        }),
  );
  // Only a group worktree can go missing: a deleted one fails the status read or no longer
  // reads as a checkout. The project root of a non-git project is simply not a repository.
  const missing =
    group.worktreePath !== null &&
    ((status.data === null && status.error !== null) || status.data?.isRepo === false);

  const { recreateWorktree } = useThreadGroupActions();
  const canOrchestrate = useEnvironmentScope(group.environmentId, AuthOrchestrationOperateScope);
  const [recreating, setRecreating] = useState(false);
  const recreate = async (groupId: ThreadGroupId) => {
    setRecreating(true);
    try {
      await recreateWorktree({ environmentId: group.environmentId, id: groupId });
    } finally {
      setRecreating(false);
    }
    // The worktree is back on disk: read its status again.
    status.refresh();
  };

  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(group.environmentId));
  const canReveal =
    isElectron &&
    serverConfig?.shellRevealInFileManager === true &&
    serverConfig.availableEditors.includes("file-manager");
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const reveal = async (path: string) => {
    const result = await openInEditor({
      environmentId: group.environmentId,
      input: { cwd: path, editor: "file-manager", reveal: true },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      errorToast("Unable to reveal the folder", squashAtomCommandFailure(result));
    }
  };

  const branchCopy = useCopyToClipboard();
  const pathCopy = useCopyToClipboard();
  const openLinkInPanel = useOpenLink(props.threadRef);
  const openLink = (url: string) => {
    void openLinkInPanel(url).catch((error: unknown) => {
      errorToast("Unable to open the link", error);
    });
  };
  const openServer = useOpenServerUrl(props.threadRef);
  const navigate = useNavigate();

  const updateGroup = useOrchestrationCommand(threadGroupCommands.update, {
    reportFailure: false,
  });
  const saveLinks = async (links: ReadonlyArray<ThreadGroupLink>, failureTitle: string) => {
    const groupId = group.id ?? (await props.ensureGroup());
    if (groupId === null) return;
    const result = await updateGroup({
      environmentId: group.environmentId,
      input: { groupId, patch: { links } },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      errorToast(failureTitle, squashAtomCommandFailure(result));
    }
  };
  const [linking, setLinking] = useState(false);

  const prStatus = useGroupPullRequestStatus(group, group.pullRequest);
  const tickets = ticketChips(
    group.links,
    group.pullRequest === null ? null : { ...group.pullRequest, title: prStatus.title },
  );
  const script = frontendScript(props.scripts);
  const frontend = glanceFrontend(script, props.resources);
  const activity = groupActivity(
    props.members.map((member) => ({
      status: resolveSidebarThreadStatus(member),
      activityMs: sidebarActivityMs(member),
    })),
  );
  const branch = group.branch ?? status.data?.refName ?? null;
  const cards = glanceCards({
    branch,
    worktreePath: group.worktreePath,
    vcs:
      status.data == null
        ? null
        : {
            ahead: status.data.aheadOfDefaultCount ?? status.data.aheadCount,
            behind: status.data.behindCount,
            baseRef: status.data.branchChanges?.baseRef ?? null,
            changedFiles: status.data.workingTree.files.length,
          },
    pullRequest:
      group.pullRequest === null
        ? null
        : {
            number: group.pullRequest.number,
            title: prStatus.title,
            state: prStatus.state,
            checksText: prStatus.checksText,
            checksFailing: prStatus.checksState === "failing",
            signInRequired: prStatus.signInRequired,
          },
    tickets,
    frontend,
    activity,
  });

  const renderCard = (card: GlanceCard) => {
    switch (card.id) {
      case "branch":
        return (
          <GlanceCardView
            key={card.id}
            card={card}
            mono
            action={
              branch === null ? null : (
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label="Copy branch name"
                  onClick={() => branchCopy.copyToClipboard(branch, undefined)}
                >
                  {branchCopy.isCopied ? <CheckIcon /> : <CopyIcon />}
                </Button>
              )
            }
          />
        );
      case "pull-request": {
        const link = group.pullRequest;
        return (
          <GlanceCardView
            key={card.id}
            card={card}
            action={
              link === null ? null : (
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label="Open pull request"
                  onClick={() =>
                    useRightPanelStore.getState().openPullRequest(props.threadRef, {
                      projectId: group.projectId,
                      host: link.host,
                      repository: link.repository,
                      number: link.number,
                      url: link.url,
                    })
                  }
                >
                  <ExternalLinkIcon />
                </Button>
              )
            }
          >
            {prStatus.state === null || card.empty ? null : (
              <span className="flex min-w-0 items-center gap-1.5">
                <span
                  className={cn(
                    "shrink-0 rounded-sm bg-accent px-1.5 py-px font-medium text-2xs capitalize",
                    TONE_CLASS[card.tone],
                  )}
                >
                  {prStatus.state}
                </span>
                <span className="min-w-0 truncate text-foreground text-sm">{card.primary}</span>
              </span>
            )}
          </GlanceCardView>
        );
      }
      case "tickets": {
        const chipProps = {
          tickets,
          canUnlink: canOrchestrate,
          onOpen: openLink,
          onUnlink: (linkId: string) =>
            void saveLinks(
              group.links.filter((link) => link.id !== linkId),
              "Failed to unlink the ticket",
            ),
        };
        return (
          <GlanceCardView
            key={card.id}
            // The compact row shows the chips themselves, so they open and unlink at any width.
            card={tickets.length === 0 ? card : { ...card, compact: null }}
            compactContent={
              tickets.length === 0 ? undefined : <CompactTicketChips {...chipProps} />
            }
            action={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Link ticket"
                disabled={!canOrchestrate}
                onClick={() => setLinking(true)}
              >
                <PlusIcon />
              </Button>
            }
          >
            {tickets.length === 0 ? null : <TicketChips {...chipProps} />}
          </GlanceCardView>
        );
      }
      case "frontend": {
        const running = frontend?.running === true;
        const previewUrl = script?.previewUrl;
        return (
          <GlanceCardView
            key={card.id}
            card={card}
            mono={running}
            dot={running}
            action={
              script === null ? (
                <Button
                  size="xs"
                  variant="ghost-muted"
                  onClick={() => void navigate({ to: "/settings/projects" })}
                >
                  Set up
                </Button>
              ) : running && previewUrl !== undefined ? (
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label="Open frontend in preview"
                  onClick={() =>
                    void openServer(previewUrl).catch((error: unknown) => {
                      errorToast("Unable to open the link", error);
                    })
                  }
                >
                  <ExternalLinkIcon />
                </Button>
              ) : (
                <Button
                  size="xs"
                  variant="ghost-muted"
                  aria-label={`Start ${script.name}`}
                  disabled={!runner.canOperate || runner.startState(script.id) !== "idle"}
                  onClick={() => void runner.start(script, props.threadRef.threadId)}
                >
                  <PlayIcon aria-hidden />
                  {runner.startState(script.id) === "starting" ? "Starting…" : "Start"}
                </Button>
              )
            }
          />
        );
      }
      case "worktree": {
        // Only the group that owns the worktree can recreate it; a solo chat's own
        // worktree has no group to recreate it from.
        const recreateGroupId = missing
          ? group.worktreeGroupId === undefined
            ? group.id
            : group.worktreeGroupId
          : null;
        return (
          <GlanceCardView
            key={card.id}
            // A missing worktree keeps its Recreate button in view at every width.
            card={missing ? { ...card, secondary: "Workspace missing", compact: null } : card}
            secondaryTone={missing ? "warning" : undefined}
            action={
              recreateGroupId !== null ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!canOrchestrate || recreating}
                  onClick={() => void recreate(recreateGroupId)}
                >
                  {recreating ? "Recreating…" : "Recreate worktree"}
                </Button>
              ) : cwd === null ? null : canReveal ? (
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label="Reveal in file manager"
                  onClick={() => void reveal(cwd)}
                >
                  <FolderOpenIcon />
                </Button>
              ) : (
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label="Copy path"
                  onClick={() => pathCopy.copyToClipboard(cwd, undefined)}
                >
                  {pathCopy.isCopied ? <CheckIcon /> : <CopyIcon />}
                </Button>
              )
            }
          >
            {group.worktreePath === null ? null : (
              <span className="flex min-w-0 font-mono text-foreground text-sm">
                <MiddleTruncate value={card.primary} />
              </span>
            )}
          </GlanceCardView>
        );
      }
      case "activity":
        return <GlanceCardView key={card.id} card={card} action={null} />;
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col divide-y divide-border rounded-lg border border-border bg-muted/30 @min-[440px]/group-panel:grid @min-[440px]/group-panel:grid-cols-2 @min-[440px]/group-panel:gap-2 @min-[440px]/group-panel:divide-y-0 @min-[440px]/group-panel:rounded-none @min-[440px]/group-panel:border-0 @min-[440px]/group-panel:bg-transparent">
        {cards.map(renderCard)}
      </div>
      {linking ? (
        <LinkTicketInput
          onCancel={() => setLinking(false)}
          onSubmit={(url, label) => {
            setLinking(false);
            if (group.links.some((link) => link.url === url)) return;
            void saveLinks(
              [...group.links, { id: `link:${randomUUID()}`, url, label }],
              "Failed to link the ticket",
            );
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * One glance fact as a compact row (below 440px) and as a card (440px and up).
 * The compact row's action replaces its right-hand text on hover or focus.
 */
function GlanceCardView(props: {
  card: GlanceCard;
  action: ReactNode;
  /** Replaces the card's primary line. */
  children?: ReactNode;
  /** Replaces the compact row's primary text. */
  compactContent?: ReactNode | undefined;
  mono?: boolean;
  /** A running dot before the primary text. */
  dot?: boolean;
  secondaryTone?: "warning" | undefined;
}) {
  const { card } = props;
  const Icon = CARD_ICON[card.id];
  const primaryClass = cn(
    "min-w-0 truncate text-sm",
    props.mono === true && !card.empty && "font-mono",
    TONE_CLASS[card.tone],
  );
  const dot =
    props.dot === true ? (
      <span aria-hidden className="size-2 shrink-0 rounded-full bg-success" />
    ) : null;
  const secondaryWarning = props.secondaryTone === "warning" || card.tone === "warning";
  return (
    <div className="group/glance min-w-0 @min-[440px]/group-panel:rounded-lg @min-[440px]/group-panel:border @min-[440px]/group-panel:border-border @min-[440px]/group-panel:bg-muted/30 @min-[440px]/group-panel:p-2.5">
      {/* Compact row: one fact, its action replacing the right-hand text on hover or focus. */}
      <div className="flex min-h-8 min-w-0 items-center gap-2 px-2.5 py-1 @min-[440px]/group-panel:hidden">
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="sr-only">{card.title}</span>
        {dot}
        {props.compactContent ?? <span className={cn(primaryClass, "flex-1")}>{card.primary}</span>}
        {card.compact !== null ? (
          <span className="shrink-0 text-muted-foreground text-xs tabular-nums group-focus-within/glance:hidden group-hover/glance:hidden">
            {card.compact}
          </span>
        ) : null}
        {props.action !== null ? (
          <span
            className={cn(
              "shrink-0",
              card.compact !== null &&
                "hidden group-focus-within/glance:flex group-hover/glance:flex",
            )}
          >
            {props.action}
          </span>
        ) : null}
      </div>
      {/* Card. */}
      <div className="hidden min-w-0 flex-col gap-1 @min-[440px]/group-panel:flex">
        <div className="flex h-6 items-center gap-1.5">
          <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium text-2xs text-muted-foreground uppercase tracking-wide">
            {card.title}
          </span>
          {props.action !== null ? <span className="ms-auto">{props.action}</span> : null}
        </div>
        {props.children ?? (
          <span className="flex min-w-0 items-center gap-1.5">
            {dot}
            <span className={primaryClass}>{card.primary}</span>
          </span>
        )}
        {card.secondary !== null ? (
          <span
            className={cn(
              "truncate text-xs",
              secondaryWarning ? TONE_CLASS.warning : "text-muted-foreground",
            )}
          >
            {card.secondary}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** A chip per ticket; web links open, others are plain text. Stored links can be unlinked. */
function TicketChips(props: {
  tickets: ReadonlyArray<TicketChip>;
  canUnlink: boolean;
  onOpen: (url: string) => void;
  onUnlink: (linkId: string) => void;
}) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {props.tickets.map((chip) => {
        const { href, linkId } = chip;
        return (
          <span key={chip.url} className="inline-flex items-center">
            {href !== null ? (
              <Badge
                variant="outline"
                size="sm"
                render={<button type="button" />}
                onClick={() => props.onOpen(href)}
              >
                {chip.label}
              </Badge>
            ) : (
              <Badge variant="outline" size="sm">
                {chip.label}
              </Badge>
            )}
            {linkId !== null && props.canUnlink ? (
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Unlink ${chip.label}`}
                onClick={() => props.onUnlink(linkId)}
              >
                <XIcon />
              </Button>
            ) : null}
          </span>
        );
      })}
    </span>
  );
}

/** The compact row's chips: the first few, then a "+N" that shows the rest. */
function CompactTicketChips(props: {
  tickets: ReadonlyArray<TicketChip>;
  canUnlink: boolean;
  onOpen: (url: string) => void;
  onUnlink: (linkId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { shown, hidden } = compactTicketChips(props.tickets, expanded);
  return (
    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
      <TicketChips {...props} tickets={shown} />
      {hidden > 0 ? (
        <Badge
          variant="outline"
          size="sm"
          render={<button type="button" aria-label={`Show ${hidden} more tickets`} />}
          onClick={() => setExpanded(true)}
        >
          +{hidden}
        </Badge>
      ) : null}
    </span>
  );
}

/** Enter links the pasted URL, Escape cancels; mounted only while linking. */
function LinkTicketInput(props: {
  onSubmit: (url: string, label: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      // Only http(s) URLs get a label, so nothing else can become a link.
      const label = groupLinkLabel(draft);
      if (label === null) {
        setError("Not a web address");
        return;
      }
      props.onSubmit(draft.trim(), label);
    } else if (event.key === "Escape") {
      event.preventDefault();
      props.onCancel();
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <Input
        size="compact"
        autoFocus
        aria-label="Ticket URL"
        placeholder="Paste a Linear or GitHub issue URL"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setError(null);
        }}
        onKeyDown={handleKeyDown}
      />
      {error !== null ? <p className="text-destructive-foreground text-xs">{error}</p> : null}
    </div>
  );
}
