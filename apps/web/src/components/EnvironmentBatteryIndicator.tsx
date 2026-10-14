import { connectedHostBattery } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEnvironment } from "~/state/environments";
import { EnvironmentBattery } from "./EnvironmentBattery";

/** Live battery for a machine picker; disconnected machines omit stale readings. */
export function EnvironmentBatteryIndicator({ environmentId }: { environmentId: EnvironmentId }) {
  const environment = useEnvironment(environmentId);
  return (
    <EnvironmentBattery
      battery={connectedHostBattery(
        environment === null
          ? null
          : {
              connectionPhase: environment.connection.phase,
              serverConfig: environment.serverConfig,
            },
      )}
    />
  );
}
