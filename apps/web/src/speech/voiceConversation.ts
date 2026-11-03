import type { VoiceInputPhase } from "@t3tools/client-runtime/voice-input";

/** Listening with no speech this long goes back to waiting for the next reply. */
export const CONVERSATION_LISTEN_TIMEOUT_MS = 60_000;

export interface ConversationSnapshot {
  /** A hands-free conversation is running in this composer. */
  readonly active: boolean;
  /** Waiting for a reply to be read; the microphone is closed meanwhile. */
  readonly waiting: boolean;
}

/**
 * Hands-free conversation for one composer in voice mode. Each turn ends when
 * the environment hears the user stop; the mic then closes until a reply starts
 * being read, so speaking over it interrupts. It decides, the composer acts:
 * `sync` runs after every render and returns "listen" when dictation should start.
 */
export class VoiceConversation {
  #active = false;
  #waiting = false;
  /** The thread was seen running since the last turn was sent. */
  #sawRunning = false;
  #snapshot: ConversationSnapshot = { active: false, waiting: false };
  #listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  readonly getSnapshot = () => this.#snapshot;

  get active() {
    return this.#active;
  }

  #set(active: boolean, waiting: boolean) {
    this.#active = active;
    this.#waiting = active && waiting;
    if (this.#snapshot.active === this.#active && this.#snapshot.waiting === this.#waiting) return;
    this.#snapshot = { active: this.#active, waiting: this.#waiting };
    for (const listener of this.#listeners) listener();
  }

  /** Talk was pressed: listen now. */
  begin() {
    this.#set(true, false);
  }

  end() {
    this.#set(false, false);
  }

  /** A turn was sent; wait for its reply. */
  turnSent() {
    if (!this.#active) return;
    this.#sawRunning = false;
    this.#set(true, true);
  }

  /** Listening heard nothing for a while; close the microphone until a reply is read. */
  pause() {
    if (!this.#active) return;
    this.#sawRunning = false;
    this.#set(true, true);
  }

  sync(input: {
    readonly phase: VoiceInputPhase;
    /** A reply is being read aloud. */
    readonly speaking: boolean;
    /** The thread's agent is working. */
    readonly running: boolean;
    /** The dictation error, while `phase` is "error". */
    readonly error: string | null;
    /** True for the error a turn with no words in it ends with, which just listens again. */
    readonly quietError: (error: string) => boolean;
  }): "listen" | null {
    if (!this.#active) return null;
    if (input.phase === "error") {
      // A real failure (no microphone, the environment went away) must not retry in a loop.
      if (input.error === null || !input.quietError(input.error)) this.end();
      return null;
    }
    if (input.phase !== "idle") return null;
    if (!this.#waiting) return "listen";
    if (input.running) this.#sawRunning = true;
    if (input.speaking || (this.#sawRunning && !input.running)) {
      this.#set(true, false);
      return "listen";
    }
    return null;
  }
}
