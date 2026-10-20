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
 * Hands-free conversation for one composer while voice mode is on. Talk
 * starts it; each turn ends on its own when the environment hears the user
 * stop, and is sent. The microphone then closes until a reply starts being
 * read, and reopens for it, so speaking over the reply interrupts it and
 * listening carries on once it finishes. A turn that gets no reply read
 * (the thread finished silently) also reopens the microphone. `end` stops it.
 *
 * It decides; the composer acts. `sync` runs after every render with what the
 * composer sees and returns "listen" when dictation should start.
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
