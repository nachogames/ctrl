/**
 * What the Issues tab beside each chat was showing, so switching to an issue tab and back returns
 * to the same place. The panel only mounts while its tab is active. Kept for the page's life.
 */
export interface IssuesPanelMemory {
  readonly query: string;
  readonly folded: ReadonlySet<string>;
  readonly scrollTop: number;
  readonly scrollLeft: number;
}

const EMPTY: IssuesPanelMemory = { query: "", folded: new Set(), scrollTop: 0, scrollLeft: 0 };

const memory = new Map<string, IssuesPanelMemory>();

export function issuesPanelMemory(threadKey: string): IssuesPanelMemory {
  return memory.get(threadKey) ?? EMPTY;
}

export function rememberIssuesPanel(threadKey: string, patch: Partial<IssuesPanelMemory>) {
  memory.set(threadKey, { ...issuesPanelMemory(threadKey), ...patch });
}
