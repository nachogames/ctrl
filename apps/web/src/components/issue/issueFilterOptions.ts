import type { IssueInvolvement, IssueListState } from "@t3tools/contracts";
import { msg } from "gt-react";
import {
  AtSignIcon,
  CircleCheckIcon,
  LayersIcon,
  PenLineIcon,
  UserCheckIcon,
  UsersIcon,
} from "lucide-react";

import type { PullRequestFilterOption } from "../pullRequest/PullRequestListFilters";
import { IssueGlyph } from "./issuePresentation";

export const ISSUE_STATE_OPTIONS = [
  { value: "open", label: msg("Open", { $context: "issue state" }), Icon: IssueGlyph.issue },
  { value: "closed", label: msg("Closed", { $context: "issue state" }), Icon: CircleCheckIcon },
  { value: "all", label: msg("All", { $context: "issue filter" }), Icon: LayersIcon },
] as const satisfies ReadonlyArray<PullRequestFilterOption<IssueListState>>;

export const ISSUE_INVOLVEMENT_OPTIONS = [
  { value: "all", label: msg("Everyone", { $context: "issue filter" }), Icon: UsersIcon },
  { value: "assigned", label: msg("Assigned to me"), Icon: UserCheckIcon },
  { value: "authored", label: msg("Opened by me"), Icon: PenLineIcon },
  { value: "mentioned", label: msg("Mentioning me"), Icon: AtSignIcon },
] as const satisfies ReadonlyArray<PullRequestFilterOption<IssueInvolvement>>;
