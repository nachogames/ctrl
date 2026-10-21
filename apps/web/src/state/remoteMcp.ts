import { createRemoteMcpEnvironmentAtoms } from "@t3tools/client-runtime/state/remoteMcp";

import { connectionAtomRuntime } from "../connection/runtime";

export const remoteMcpEnvironment = createRemoteMcpEnvironmentAtoms(connectionAtomRuntime);
