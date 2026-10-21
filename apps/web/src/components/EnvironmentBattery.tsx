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

/** Inner width of the battery body, in viewBox units. */
const BATTERY_FILL_WIDTH = 16;

function batteryFillClassName(percent: number): string {
  if (percent <= 20) return "fill-destructive";
  if (percent <= 50) return "fill-warning";
  return "fill-success";
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
  // One SVG with fixed geometry, so the body, fill, and bolt keep their proportions at any
  // size. Inline style, not classes: buttons, menus, and composer controls restyle nested
  // SVGs (`[&_svg]:-mx-0.5`, `size-*`, `opacity-*`), which used to shift the bolt.
  const fillWidth = (BATTERY_FILL_WIDTH * Math.max(battery.percent, 8)) / 100;
  const glyph = (
    <svg
      aria-hidden
      viewBox="0 0 22 10"
      overflow="visible"
      style={{ width: "1.375rem", height: "0.625rem", margin: 0, opacity: 1 }}
    >
      <rect
        x={0.5}
        y={0.5}
        width={19}
        height={9}
        rx={2.5}
        fill="none"
        strokeWidth={1}
        className="stroke-muted-foreground/60"
      />
      {/* At least a sliver, so an almost-empty battery still reads as red. */}
      <rect
        x={2}
        y={2}
        width={fillWidth}
        height={6}
        rx={1}
        className={batteryFillClassName(battery.percent)}
      />
      <rect x={20.5} y={3} width={1.5} height={4} rx={0.75} className="fill-muted-foreground/60" />
      {battery.pluggedIn ? (
        // The bolt's 24-unit path, scaled and centered on the body.
        <path
          d="M13 2 4 14h7l-1 8 9-12h-7z"
          transform="translate(5.4 0.2) scale(0.4)"
          className="fill-foreground stroke-background [paint-order:stroke]"
          strokeWidth={3}
          strokeLinejoin="round"
        />
      ) : null}
    </svg>
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
