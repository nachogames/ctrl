import { APP_ICONS, type AppIcon } from "@t3tools/contracts";
import { APP_ICON_ARTWORK } from "@t3tools/shared/appIcons";

import { cn } from "../../lib/utils";
import { AppIconMark } from "../AppIconMark";

export function AppIconPicker({
  value,
  onChange,
}: {
  readonly value: AppIcon;
  readonly onChange: (appIcon: AppIcon) => void;
}) {
  return (
    <div role="radiogroup" aria-label="App icon" className="flex gap-1.5">
      {APP_ICONS.map((design) => (
        <button
          key={design}
          type="button"
          role="radio"
          aria-checked={value === design}
          onClick={() => onChange(design)}
          className={cn(
            "flex w-16 flex-col items-center gap-1 rounded-lg p-1.5 text-2xs outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset",
            value === design
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:bg-accent/50",
          )}
        >
          <span className="flex size-11 items-center justify-center rounded-lg bg-black">
            <AppIconMark design={design} tone="color" className="size-9" aria-hidden />
          </span>
          {APP_ICON_ARTWORK[design].label}
        </button>
      ))}
    </div>
  );
}
