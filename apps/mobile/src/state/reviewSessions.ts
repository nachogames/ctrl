import { createReviewSessionEnvironmentAtoms } from "@t3tools/client-runtime/state/review-sessions";

import { connectionAtomRuntime } from "../connection/runtime";

/** The Review tab's live session, the list's waiting markers, and the review commands. */
export const reviewSessionEnvironment = createReviewSessionEnvironmentAtoms(connectionAtomRuntime);
