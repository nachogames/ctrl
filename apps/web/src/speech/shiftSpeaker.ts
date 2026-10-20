import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { spokenOpening } from "@t3tools/client-runtime/spoken-opening";
import type { EnvironmentId } from "@t3tools/contracts";
import type { AtomRegistry } from "effect/reactivity";

import { speechEnvironment } from "../state/speech";

interface Pending {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly environmentId: EnvironmentId;
  readonly text: string;
}

export function decodeBase64(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

/**
 * Reads the openings of Shift's replies aloud, one sentence at a time. Each
 * sentence is synthesized by the environment while the previous one plays,
 * and played back to back through one AudioContext. `stop` silences it at
 * once and drops whatever was left of the messages it was reading.
 */
class ShiftSpeaker {
  #context: AudioContext | null = null;
  #generation = 0;
  #queue: Pending[] = [];
  #pumping = false;
  #playheadEnd = 0;
  #sources = new Set<AudioBufferSourceNode>();
  #speaking = false;
  #listeners = new Set<() => void>();
  /** Per message: how many opening sentences were queued, and whether it is finished. */
  #messages = new Map<string, { queued: number; done: boolean }>();
  #warnedFailure = false;

  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  readonly isSpeaking = () => this.#speaking;

  #setSpeaking(speaking: boolean) {
    if (this.#speaking === speaking) return;
    this.#speaking = speaking;
    for (const listener of this.#listeners) listener();
  }

  #audio(): AudioContext {
    this.#context ??= new AudioContext();
    if (this.#context.state === "suspended") void this.#context.resume();
    return this.#context;
  }

  /** Opens audio output from a user gesture, so later playback is allowed to start. */
  prime() {
    this.#audio();
  }

  /** Messages that should never be read, such as everything already in the thread. */
  markHeard(messageIds: Iterable<string>) {
    for (const id of messageIds)
      if (!this.#messages.has(id)) this.#messages.set(id, { queued: 0, done: true });
  }

  /** True when this message was never seen by the speaker. */
  isNew(messageId: string) {
    return !this.#messages.has(messageId);
  }

  /** Queues any opening sentences of this message that are complete and not yet queued. */
  feed(input: {
    readonly registry: AtomRegistry.AtomRegistry;
    readonly environmentId: EnvironmentId;
    readonly messageId: string;
    readonly text: string;
    readonly streaming: boolean;
  }) {
    let entry = this.#messages.get(input.messageId);
    if (!entry) {
      entry = { queued: 0, done: false };
      this.#messages.set(input.messageId, entry);
    }
    if (entry.done) return;
    const opening = spokenOpening(input.text, input.streaming);
    for (const text of opening.sentences.slice(entry.queued)) {
      this.#queue.push({ registry: input.registry, environmentId: input.environmentId, text });
    }
    entry.queued = Math.max(entry.queued, opening.sentences.length);
    if (opening.complete) entry.done = true;
    if (this.#queue.length > 0) {
      this.#setSpeaking(true);
      void this.#pump();
    }
  }

  /** Silences playback now and drops the rest of every message being read. */
  stop() {
    this.#generation++;
    this.#queue = [];
    for (const entry of this.#messages.values()) entry.done = true;
    for (const source of this.#sources) {
      source.onended = null;
      source.stop();
    }
    this.#sources.clear();
    this.#playheadEnd = 0;
    this.#setSpeaking(false);
  }

  async #pump() {
    if (this.#pumping) return;
    this.#pumping = true;
    const generation = this.#generation;
    try {
      while (this.#queue.length > 0 && generation === this.#generation) {
        const next = this.#queue.shift()!;
        const result = await runAtomCommand(
          next.registry,
          speechEnvironment.synthesize,
          { environmentId: next.environmentId, input: { text: next.text } },
          { reportFailure: false },
        );
        if (generation !== this.#generation) return;
        if (result._tag === "Failure") {
          if (!this.#warnedFailure) console.warn("[speech] Could not speak a reply.", result.cause);
          this.#warnedFailure = true;
          continue;
        }
        const context = this.#audio();
        const buffer = await context
          .decodeAudioData(decodeBase64(result.value.wav))
          .catch(() => null);
        if (generation !== this.#generation) return;
        if (buffer === null) continue;
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        const start = Math.max(context.currentTime + 0.02, this.#playheadEnd);
        this.#playheadEnd = start + buffer.duration;
        source.onended = () => {
          this.#sources.delete(source);
          this.#settle();
        };
        this.#sources.add(source);
        source.start(start);
      }
    } finally {
      this.#pumping = false;
      // Sentences queued while a request was in flight, including after a stop, still need a pump.
      if (this.#queue.length > 0) void this.#pump();
      else this.#settle();
    }
  }

  #settle() {
    if (!this.#pumping && this.#queue.length === 0 && this.#sources.size === 0) {
      this.#setSpeaking(false);
    }
  }
}

export const shiftSpeaker = new ShiftSpeaker();
