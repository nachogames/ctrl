import { connectedHostBattery } from "@t3tools/client-runtime/connection";
import {
  type EnvironmentId,
  type HostBattery,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";

import { cn } from "../lib/utils";
import { useEnvironment } from "../state/environments";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

function batteryFillClassName(percent: number): string {
  if (percent <= 20) return "bg-destructive";
  if (percent <= 50) return "bg-warning";
  return "bg-success";
}

export function batteryLabel(battery: HostBattery): string {
  return `${battery.percent}% · ${battery.pluggedIn ? "Plugged in" : "On battery"}`;
}

/**
 * A machine's battery drawn as a battery: the fill shows the level, colored
 * green, yellow, or red, with a bolt over it while on power. The exact
 * percent is in the tooltip; inside another tooltip's trigger, pass
 * `tooltip={false}` and put `batteryLabel` in that tooltip. Pass null to hide it.
 */
export function EnvironmentBattery(props: {
  readonly battery: HostBattery | null | undefined;
  readonly tooltip?: boolean;
  readonly className?: string;
}) {
  const { battery } = props;
  if (battery == null) return null;
  const label = batteryLabel(battery);
  const glyph = (
    <span className="relative flex items-center">
      <span className="flex h-2.5 w-5 rounded-[3px] border border-muted-foreground/60 p-px">
        <span
          className={cn("h-full rounded-[1.5px]", batteryFillClassName(battery.percent))}
          // At least a sliver, so an almost-empty battery still reads as red.
          style={{ width: `${Math.max(battery.percent, 8)}%` }}
        />
      </span>
      <span className="h-1 w-0.5 rounded-r-[1px] bg-muted-foreground/60" />
      {battery.pluggedIn ? (
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          className="absolute top-1/2 left-1 size-3 -translate-y-1/2 fill-foreground stroke-background [paint-order:stroke]"
          strokeWidth={3}
          strokeLinejoin="round"
        >
          <path d="M13 2 4 14h7l-1 8 9-12h-7z" />
        </svg>
      ) : null}
    </span>
  );
  const className = cn("inline-flex shrink-0 items-center", props.className);
  if (props.tooltip === false) {
    return (
      <span role="img" aria-label={`Battery ${label}`} className={className}>
        {glyph}
      </span>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        payload={label}
        render={<span role="img" aria-label={`Battery ${label}`} className={className} />}
      >
        {glyph}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** A machine's name and battery, for the chat header. Hidden when there is no battery to show. */
export function EnvironmentBatteryChip(props: { readonly environmentId: EnvironmentId }) {
  const environment = useEnvironment(props.environmentId);
  const battery = connectedHostBattery(
    environment === null
      ? null
      : { connectionPhase: environment.connection.phase, serverConfig: environment.serverConfig },
  );
  if (environment === null || battery === null) return null;
  return (
    <span className="hidden shrink-0 items-center gap-1.5 text-muted-foreground text-xs sm:inline-flex">
      <EnvironmentMachineIcon
        kind={resolveEnvironmentMachineKind(environment.serverConfig)}
        className="size-3 shrink-0"
      />
      <span className="max-w-32 truncate">{environment.label}</span>
      <EnvironmentBattery battery={battery} />
    </span>
  );
}
