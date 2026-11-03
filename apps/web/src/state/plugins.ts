import { createPluginEnvironmentAtoms } from "@t3tools/client-runtime/state/plugins";

import { connectionAtomRuntime } from "../connection/runtime";

/** Local plugins, what they draw on threads, and their commands. */
export const pluginEnvironment = createPluginEnvironmentAtoms(connectionAtomRuntime);
