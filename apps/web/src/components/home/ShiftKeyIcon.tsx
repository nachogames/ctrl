import { createLucideIcon } from "lucide-react";

/** Shift's mark: a Mac keycap with the ⇧ glyph, drawn on lucide's 24px grid. */
export const ShiftKeyIcon = createLucideIcon("shift-key", [
  ["rect", { width: "19", height: "19", x: "2.5", y: "2.5", rx: "4.5", key: "keycap" }],
  ["path", { d: "M12 6.75 16.75 11.75H14.25V16.5H9.75V11.75H7.25Z", key: "glyph" }],
]);
