import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { spokenOpening } from "@t3tools/client-runtime/spoken-opening";
import { GEMINI_LIVE_OUTPUT_SAMPLE_RATE, type EnvironmentId } from "@t3tools/contracts";
import type { AtomRegistry } from "effect/reactivity";

import { speechEnvironment } from "../state/speech";

interface Pending {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly environmentId: EnvironmentId;
  readonly messageId: string;
  readonly text: string;
}

/**
 * Where the front voice is in the current voice turn. While it is "pending",
 * new agent replies wait; once it "answered", they are not read for that turn.
 */
export type FrontMode = "idle" | "pending" | "answered";

export function decodeBase64(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

/** Lead time for a fresh audio stream, so network jitter between its chunks does not click. */
const STREAM_LEAD_SECONDS = 0.12;

/** 16-bit little-endian PCM as samples for an AudioBuffer. */
function decodePcm16(base64: string): Float32Array<ArrayBuffer> {
  const view = new DataView(decodeBase64(base64));
  const samples = new Float32Array(Math.floor(view.byteLength / 2));
  for (let index = 0; index < samples.length; index++)
    samples[index] = view.getInt16(index * 2, true) / 32768;
  return samples;
}

/**
 * Reads the openings of agent replies aloud, one sentence at a time. Each
 * sentence is synthesized by the environment while the previous one plays,
 * and played back to back through one AudioContext. `stop` silences it at
 * once and drops whatever was left of the messages it was reading.
 */
class ReplySpeaker {
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
  #front: FrontMode = "idle";
  /** Resolved with `performance.now()` when a message's first sentence starts playing. */
  #firstAudio = new Map<string, (at: number) => void>();
  /** Audio streams still sending chunks; speech counts as going on between them. */
  #openStreams = new Set<string>();

  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  readonly isSpeaking = () => this.#speaking;

  readonly frontMode = () => this.#front;

  #notify() {
    for (const listener of this.#listeners) listener();
  }

  /** A voice turn went out and the front voice is answering: hold new agent replies. */
  holdForFront() {
    this.#front = "pending";
    this.#notify();
  }

  /** The front voice finished. When it fully answered, this turn's agent replies stay quiet. */
  releaseFront(answered: boolean) {
    if (this.#front !== "pending") return;
    this.#front = answered ? "answered" : "idle";
    this.#notify();
  }

  /** A new turn that is not a voice turn: agent replies are read again. */
  clearFront() {
    if (this.#front === "idle") return;
    this.#front = "idle";
    this.#notify();
  }

  /** Resolves with `performance.now()` once this message's first sentence starts playing. */
  whenPlaying(messageId: string): Promise<number> {
    return new Promise((resolve) => this.#firstAudio.set(messageId, resolve));
  }

  #setSpeaking(speaking: boolean) {
    if (this.#speaking === speaking) return;
    this.#speaking = speaking;
    this.#notify();
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
    /** The front voice's own reply, which the front mode never holds back. */
    readonly front?: boolean;
  }) {
    if (!input.front && this.isNew(input.messageId)) {
      // Not recorded yet, so the reply is fed again once the front decides.
      if (this.#front === "pending") return;
      if (this.#front === "answered") {
        this.markHeard([input.messageId]);
        return;
      }
    }
    let entry = this.#messages.get(input.messageId);
    if (!entry) {
      entry = { queued: 0, done: false };
      this.#messages.set(input.messageId, entry);
    }
    if (entry.done) return;
    const opening = spokenOpening(input.text, input.streaming);
    for (const text of opening.sentences.slice(entry.queued)) {
      this.#queue.push({
        registry: input.registry,
        environmentId: input.environmentId,
        messageId: input.messageId,
        text,
      });
    }
    entry.queued = Math.max(entry.queued, opening.sentences.length);
    if (opening.complete) entry.done = true;
    if (this.#queue.length > 0) {
      this.#setSpeaking(true);
      void this.#pump();
    }
  }

  /**
   * Plays the front voice's own audio (Gemini's 24 kHz PCM) as its chunks
   * arrive, after anything already playing. `done` ends the stream; a stream
   * `stop` silenced ignores the rest of its chunks.
   */
  feedAudio(input: {
    readonly messageId: string;
    readonly chunks: ReadonlyArray<string>;
    readonly done: boolean;
  }) {
    let entry = this.#messages.get(input.messageId);
    if (!entry) {
      entry = { queued: 0, done: false };
      this.#messages.set(input.messageId, entry);
    }
    if (entry.done) return;
    if (input.done) {
      entry.done = true;
      this.#openStreams.delete(input.messageId);
    } else this.#openStreams.add(input.messageId);
    const context = input.chunks.length > 0 ? this.#audio() : null;
    for (const chunk of input.chunks) {
      if (!context) break;
      const samples = decodePcm16(chunk);
      if (samples.length === 0) continue;
      const buffer = context.createBuffer(1, samples.length, GEMINI_LIVE_OUTPUT_SAMPLE_RATE);
      buffer.copyToChannel(samples, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      const start =
        this.#playheadEnd > context.currentTime
          ? this.#playheadEnd
          : context.currentTime + STREAM_LEAD_SECONDS;
      this.#playheadEnd = start + buffer.duration;
      const firstAudio = this.#firstAudio.get(input.messageId);
      if (firstAudio) {
        this.#firstAudio.delete(input.messageId);
        firstAudio(performance.now() + (start - context.currentTime) * 1000);
      }
      source.onended = () => {
        this.#sources.delete(source);
        this.#settle();
      };
      this.#sources.add(source);
      source.start(start);
      entry.queued += 1;
    }
    if (this.#sources.size > 0 || this.#openStreams.size > 0) this.#setSpeaking(true);
    this.#settle();
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
    this.#firstAudio.clear();
    this.#openStreams.clear();
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
        const firstAudio = this.#firstAudio.get(next.messageId);
        if (firstAudio) {
          this.#firstAudio.delete(next.messageId);
          firstAudio(performance.now() + (start - context.currentTime) * 1000);
        }
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
    if (
      !this.#pumping &&
      this.#queue.length === 0 &&
      this.#sources.size === 0 &&
      this.#openStreams.size === 0
    ) {
      this.#setSpeaking(false);
    }
  }
}

export const replySpeaker = new ReplySpeaker();
