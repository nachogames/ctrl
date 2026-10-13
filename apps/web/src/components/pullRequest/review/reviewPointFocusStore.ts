/**
 * The point open in the Review tab, per review chat, and whether the chat's composer carries it.
 * The tab writes it; the composer chip and the message tags read it. Not persisted: a reload
 * starts with nothing open, and opening a point attaches it again.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { create } from "zustand";

export interface ReviewPointFocus {
  readonly number: number;
  readonly label: string;
  /** The user pressed × on the chip; the point stays open in the tab. */
  readonly detached: boolean;
}

/** Where the review chat's pull request lives, so a message tag can open it. */
export interface ReviewChatTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
}

interface ReviewPointFocusState {
  /** Keyed by the review chat's `scopedThreadKey`. */
  readonly focus: Readonly<Record<string, ReviewPointFocus>>;
  readonly reviewChats: Readonly<Record<string, ReviewChatTarget>>;
  /** A message tag asked the panel to open this point on the Review tab. */
  readonly openRequest: { readonly threadKey: string; readonly number: number } | null;
  readonly openPoint: (threadKey: string, point: { number: number; label: string }) => void;
  readonly closePoint: (threadKey: string) => void;
  readonly detach: (threadKey: string) => void;
  readonly attach: (threadKey: string) => void;
  readonly registerReviewChat: (threadKey: string, target: ReviewChatTarget) => void;
  readonly requestOpen: (threadKey: string, number: number) => void;
  readonly clearOpenRequest: () => void;
}

export const useReviewPointFocusStore = create<ReviewPointFocusState>()((set) => ({
  focus: {},
  reviewChats: {},
  openRequest: null,
  openPoint: (threadKey, point) =>
    set((state) => ({ focus: { ...state.focus, [threadKey]: { ...point, detached: false } } })),
  closePoint: (threadKey) =>
    set((state) => {
      if (state.focus[threadKey] === undefined) return state;
      const { [threadKey]: _closed, ...focus } = state.focus;
      return { focus };
    }),
  detach: (threadKey) =>
    set((state) => {
      const current = state.focus[threadKey];
      return current === undefined
        ? state
        : { focus: { ...state.focus, [threadKey]: { ...current, detached: true } } };
    }),
  attach: (threadKey) =>
    set((state) => {
      const current = state.focus[threadKey];
      return current === undefined
        ? state
        : { focus: { ...state.focus, [threadKey]: { ...current, detached: false } } };
    }),
  registerReviewChat: (threadKey, target) =>
    set((state) => {
      const current = state.reviewChats[threadKey];
      if (current?.url === target.url && current.environmentId === target.environmentId) {
        return state;
      }
      return { reviewChats: { ...state.reviewChats, [threadKey]: target } };
    }),
  requestOpen: (threadKey, number) => set({ openRequest: { threadKey, number } }),
  clearOpenRequest: () => set({ openRequest: null }),
}));

/** The point a message sent from this chat's composer is about right now, if any. */
export function readAttachedReviewPoint(
  threadKey: string,
): { readonly number: number; readonly label: string } | null {
  const focus = useReviewPointFocusStore.getState().focus[threadKey];
  return focus === undefined || focus.detached
    ? null
    : { number: focus.number, label: focus.label };
}
