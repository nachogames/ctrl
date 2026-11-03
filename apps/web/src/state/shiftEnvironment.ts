import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import {
  readLocalStorageValue,
  subscribeLocalStorageKey,
  useLocalStorage,
} from "../hooks/useLocalStorage";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { serverEnvironment } from "./server";

const SHIFT_ENVIRONMENT_KEY = "ctrl:shift-environment";
const ShiftEnvironmentChoice = Schema.NullOr(EnvironmentId);

const readChoice = () => readLocalStorageValue(SHIFT_ENVIRONMENT_KEY, null, ShiftEnvironmentChoice);

/** The machine this device uses Shift from; null means this machine. Saved per device. */
export function useShiftEnvironmentChoice() {
  return useLocalStorage(SHIFT_ENVIRONMENT_KEY, null, ShiftEnvironmentChoice);
}

const shiftEnvironmentChoiceAtom = Atom.make((get) => {
  get.addFinalizer(
    subscribeLocalStorageKey(SHIFT_ENVIRONMENT_KEY, () => get.setSelf(readChoice())),
  );
  return readChoice();
}).pipe(Atom.withLabel("web-shift-environment-choice"));

/**
 * The machine whose Shift the pinned row, shortcut and palette open: the
 * chosen one while it can run Shift (a desktop app's own server), else this
 * machine, so a machine that went away never strands Shift.
 */
export const shiftEnvironmentIdAtom = Atom.make((get) => {
  const chosen = get(shiftEnvironmentChoiceAtom);
  if (chosen !== null && get(serverEnvironment.configValueAtom(chosen))?.homeWorkspaceRoot)
    return chosen;
  return get(primaryEnvironmentIdAtom);
}).pipe(Atom.withLabel("web-shift-environment-id"));

/** The open Shift thread on that machine, or null while Shift is off there. */
export const shiftThreadIdAtom = Atom.make((get) => {
  const environmentId = get(shiftEnvironmentIdAtom);
  if (environmentId === null) return null;
  return get(serverEnvironment.settingsValueAtom(environmentId))?.home.threadId ?? null;
}).pipe(Atom.withLabel("web-shift-thread-id"));
