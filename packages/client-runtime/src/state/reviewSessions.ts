import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export * from "./reviewSessionPresentation.ts";

export function createReviewSessionEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  return {
    host: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:review-host",
      tag: WS_METHODS.reviewSessionsReadHost,
    }),
    startFromPullRequest: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:review-start-pr",
      tag: WS_METHODS.reviewSessionsStartFromPullRequest,
    }),
    /** The pull request's review in the chat's group (`snapshot: null` when none), live while read. */
    session: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:review-session",
      tag: WS_METHODS.reviewSessionsSubscribe,
      // Nothing else needs the stream once the Review tab closes.
      idleTtlMs: 0,
    }),
    /** Exactly what one review said, read when it is expanded. */
    sourceComments: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:review-source-comments",
      tag: WS_METHODS.reviewSessionsReadSource,
    }),
    decide: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:review-session:decide",
      tag: WS_METHODS.reviewSessionsDecide,
    }),
    setViewed: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:review-session:set-viewed",
      tag: WS_METHODS.reviewSessionsSetViewed,
    }),
    editReply: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:review-session:edit-reply",
      tag: WS_METHODS.reviewSessionsEditReply,
    }),
    /** Triage, Apply, or a reply rewrite, as a turn in the review chat. */
    request: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:review-session:request",
      tag: WS_METHODS.reviewSessionsRequest,
    }),
    runLocalReview: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:review-session:run-local-review",
      tag: WS_METHODS.reviewSessionsRunLocalReview,
    }),
    discussInSideChat: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:review-session:side-chat",
      tag: WS_METHODS.reviewSessionsDiscussInSideChat,
    }),
  };
}
