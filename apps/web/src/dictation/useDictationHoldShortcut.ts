import { useEffect, useLayoutEffect, useRef } from "react";

import { isTerminalFocused } from "../lib/terminalFocus";
import type { ComposerDictation } from "./useComposerDictation";

const MODIFIER_KEYS = new Set(["Alt", "AltGraph", "Control", "Meta", "Shift"]);

/**
 * Hold-to-talk for `composer.dictate` while this window has focus: pressing starts,
 * releasing the key or a modifier (or losing focus) stops and transcribes, and
 * Escape cancels outside the terminal. Matching presses are always claimed so
 * macOS does not type Option+Space's non-breaking space into the editor.
 */
export function useDictationHoldShortcut(input: {
  readonly dictation: ComposerDictation;
  /** False while the composer cannot take text; presses are still claimed. */
  readonly enabled: boolean;
  readonly isDictateShortcut: (event: KeyboardEvent) => boolean;
  /** Replaces starting dictation, as voice mode does to start a conversation. */
  readonly start?: () => void;
  /**
   * Runs first on Escape outside the terminal, even while dictation is idle;
   * true claims the key. Voice mode uses it to end a conversation.
   */
  readonly escape?: () => boolean;
}) {
  const latest = useRef(input);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes committed inputs to a ref the window key listeners read
  useLayoutEffect(() => {
    latest.current = input;
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds the window key and blur listeners for hold-to-talk while mounted
  useEffect(() => {
    // The physical key that started the hold, so only its release ends it.
    let heldCode: string | null = null;

    const release = () => {
      if (heldCode === null) return;
      heldCode = null;
      const { dictation } = latest.current;
      // Audio is captured from the moment the microphone opens, so a release
      // during setup still transcribes; with nothing captured there is nothing to keep.
      if (dictation.readPhase() === "preparing" && !dictation.capturedAudio()) dictation.cancel();
      else dictation.stop();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const { dictation, enabled, isDictateShortcut, start, escape } = latest.current;
      const phase = dictation.readPhase();
      const active = phase === "preparing" || phase === "recording" || phase === "transcribing";
      if (event.key === "Escape" && escape && !isTerminalFocused() && escape()) {
        event.preventDefault();
        event.stopPropagation();
        heldCode = null;
        return;
      }
      // The terminal keeps its own Escape (vim, less) even while dictation runs.
      if (event.key === "Escape" && active && !isTerminalFocused()) {
        event.preventDefault();
        event.stopPropagation();
        heldCode = null;
        dictation.cancel();
        return;
      }
      if (!isDictateShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat || heldCode !== null) return;
      if (phase === "recording") {
        dictation.stop();
        return;
      }
      if (active || !enabled) return;
      heldCode = event.code;
      (start ?? dictation.start)();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (heldCode === null) return;
      if (event.code !== heldCode && !MODIFIER_KEYS.has(event.key)) return;
      event.preventDefault();
      release();
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", release);
    };
  }, []);
}
