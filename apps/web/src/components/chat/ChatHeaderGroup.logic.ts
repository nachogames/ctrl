/** One breadcrumb item as laid out, for `breadcrumbNaturalWidth`. */
export interface BreadcrumbItemMeasure {
  /** Rendered width of the item's content box (its first child). */
  readonly boxWidth: number;
  /** Rendered width of the item's label, or null for a width-capped label that never grows. */
  readonly labelBoxWidth: number | null;
  /** Width of the label's text run, untruncated and unstretched. */
  readonly labelTextWidth: number;
  /** Width of a collapsed parent's "..." stand-in, 0 when absent. */
  readonly ellipsisWidth: number;
}

/**
 * The breadcrumb's width with every growable label at its natural text width:
 * a truncated label counts its full text, a label stretched to fill the row
 * (the title) counts only its text, and a collapsed parent counts its title
 * instead of its "...".
 */
export function breadcrumbNaturalWidth(
  items: ReadonlyArray<BreadcrumbItemMeasure>,
  gap: number,
): number {
  return items.reduce(
    (total, item) =>
      total +
      item.boxWidth +
      (item.labelBoxWidth === null ? 0 : item.labelTextWidth - item.labelBoxWidth) -
      item.ellipsisWidth,
    gap * Math.max(items.length - 1, 0),
  );
}

/**
 * Whether the chat header shows the group's branch, PR and count chips. They
 * are the first thing to give up width: they show only when the breadcrumb at
 * its natural width (title untruncated) plus the chips fit the header, and
 * never while the Group surface already shows the same facts beside the chat.
 */
export function shouldShowGroupChips(input: {
  /** The header's content width, which the breadcrumb and chips share. */
  readonly headerWidth: number;
  /** `breadcrumbNaturalWidth` of the breadcrumb items, chips excluded. */
  readonly breadcrumbWidth: number;
  /** Natural width of the chip group plus the gap before it. */
  readonly chipsWidth: number;
  readonly groupPanelVisible: boolean;
}): boolean {
  if (input.groupPanelVisible) return false;
  return input.headerWidth - input.breadcrumbWidth - input.chipsWidth >= 0;
}

export function groupChatCountLabel(count: number): string {
  return count === 1 ? "1 chat" : `${count} chats`;
}
