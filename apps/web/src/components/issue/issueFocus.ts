/**
 * The issue a chat is about: the issue tab open in its right panel, unless the user pressed × on
 * the composer strip for that issue. Derived from the panel, so opening another issue moves the
 * focus with no extra writes. Not persisted.
 */
import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { formatIssueTag } from "@t3tools/shared/issueTag";
import { create } from "zustand";

import {
  selectActiveRightPanelSurface,
  useRightPanelStore,
  type IssueSurface,
} from "~/rightPanelStore";

interface IssueFocusState {
  /** The issue tab whose strip the user closed, per chat. */
  readonly detached: Readonly<Record<string, string>>;
  readonly detach: (threadKey: string, surfaceId: string) => void;
  readonly attach: (threadKey: string) => void;
}

export const useIssueFocusStore = create<IssueFocusState>()((set) => ({
  detached: {},
  detach: (threadKey, surfaceId) =>
    set((state) => ({ detached: { ...state.detached, [threadKey]: surfaceId } })),
  attach: (threadKey) =>
    set((state) => {
      if (state.detached[threadKey] === undefined) return state;
      const { [threadKey]: _attached, ...detached } = state.detached;
      return { detached };
    }),
}));

export function focusedIssueSurface(
  byThreadKey: Parameters<typeof selectActiveRightPanelSurface>[0],
  threadRef: ScopedThreadRef,
): IssueSurface | null {
  const surface = selectActiveRightPanelSurface(byThreadKey, threadRef);
  return surface?.kind === "issue" ? surface : null;
}

// A slash command must open the message for the provider to run it.
const LEADING_SLASH_COMMAND = /^\/[^\s/]+(?:\s|$)/u;

/** What a send from this chat carries: a line naming the focused issue, then the message. */
export function withFocusedIssue(target: ScopedThreadRef | string, text: string): string {
  if (typeof target === "string" || LEADING_SLASH_COMMAND.test(text)) return text;
  const surface = focusedIssueSurface(useRightPanelStore.getState().byThreadKey, target);
  if (surface === null) return text;
  if (useIssueFocusStore.getState().detached[scopedThreadKey(target)] === surface.id) return text;
  return aboutIssue(surface.key, surface.url ?? null, text, surface.scope);
}

/** Text for the agent, opened with the issue it is about. */
export function aboutIssue(key: string, url: string | null, text: string, scope?: string): string {
  return formatIssueTag({ key, url, ...(scope === undefined ? {} : { scope }) }, text);
}
