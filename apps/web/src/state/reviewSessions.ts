import { createReviewSessionEnvironmentAtoms } from "@t3tools/client-runtime/state/review-sessions";

import { connectionAtomRuntime } from "../connection/runtime";

/** The Review tab's live session, its review comments, and its commands. */
export const reviewSessionEnvironment = createReviewSessionEnvironmentAtoms(connectionAtomRuntime);
