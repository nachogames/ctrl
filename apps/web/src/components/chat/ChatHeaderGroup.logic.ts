/**
 * Whether the chat header shows the group's branch, PR and count chips. They
 * are the first thing to give up width: they show only when the breadcrumb at
 * its natural width (title untruncated) plus the chips fit, and never while
 * the Group surface already shows the same facts beside the chat.
 */
export function shouldShowGroupChips(input: {
  /** Width the breadcrumb list can occupy. */
  readonly availableWidth: number;
  /** Natural width of the breadcrumb items, gaps included, chips excluded. */
  readonly breadcrumbWidth: number;
  /** Natural width of the chip group plus the gap before it. */
  readonly chipsWidth: number;
  readonly groupPanelVisible: boolean;
}): boolean {
  if (input.groupPanelVisible) return false;
  return input.availableWidth - input.breadcrumbWidth - input.chipsWidth >= 0;
}

export function groupChatCountLabel(count: number): string {
  return count === 1 ? "1 chat" : `${count} chats`;
}
