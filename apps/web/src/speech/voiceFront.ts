import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";
import { useSyncExternalStore } from "react";

import { speechEnvironment } from "../state/speech";
import { replySpeaker } from "./replySpeaker";

/** How long the front's words stay under the composer after it finishes. */
const CAPTION_LINGER_MS = 8_000;
/**
 * Longest the agent's reply waits on the front, covering LM Studio loading
 * the model after it went idle (about 6 s on an M-series Mac).
 */
const FRONT_DECISION_TIMEOUT_MS = 15_000;

/** The front voice's words while it talks, for a caption by the composer. */
class FrontCaption {
  #text = "";
  #listeners = new Set<() => void>();
  #timer: ReturnType<typeof setTimeout> | null = null;

  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  readonly get = () => this.#text;

  set(text: string, lingerMs?: number) {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = lingerMs === undefined ? null : setTimeout(() => this.set(""), lingerMs);
    if (this.#text === text) return;
    this.#text = text;
    for (const listener of this.#listeners) listener();
  }
}

const caption = new FrontCaption();
let turns = 0;

/** What the front voice is saying, or "" when it is quiet. */
export function useFrontCaption() {
  return useSyncExternalStore(caption.subscribe, caption.get);
}

/**
 * Asks the environment's front voice for a quick spoken reply to a voice turn
 * that was just sent, and reads it aloud as it streams in. The agent's reply
 * waits until the front decides; if the front fully answered, that reply is
 * not read. Any failure (front voice off, LM Studio down) just lets the
 * agent's reply be read as usual.
 *
 * `endOfSpeechAt` is the `performance.now()` of the end of the user's turn,
 * for the latency log.
 */
export function askVoiceFront(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly transcript: string;
  readonly endOfSpeechAt: number | null;
}) {
  const askedAt = performance.now();
  // Unique within this page; the request atom is disposed once the reply is done.
  const turnId = `${Math.round(askedAt)}-${++turns}`;
  const messageId = `voice-front:${turnId}`;
  replySpeaker.holdForFront();
  caption.set("");
  void replySpeaker.whenPlaying(messageId).then((playingAt) => {
    const from = input.endOfSpeechAt ?? askedAt;
    console.info(
      `[voice] ${input.endOfSpeechAt === null ? "send" : "end of turn"} → first audio: ${Math.round(playingAt - from)} ms`,
    );
  });
  const atom = speechEnvironment.frontReply({
    environmentId: input.environmentId,
    input: { threadId: input.threadId, transcript: input.transcript, turnId },
  });
  let settled = false;
  let unsubscribe: (() => void) | null = null;
  const timeout = setTimeout(() => {
    if (!settled) settle(false);
  }, FRONT_DECISION_TIMEOUT_MS);
  const settle = (answered: boolean) => {
    settled = true;
    clearTimeout(timeout);
    replySpeaker.releaseFront(answered);
    // Unsubscribing inside the callback would end the stream it is delivering.
    queueMicrotask(() => unsubscribe?.());
  };
  unsubscribe = input.registry.subscribe(
    atom,
    (result) => {
      if (settled) return;
      if (AsyncResult.isFailure(result)) {
        caption.set("");
        settle(false);
        return;
      }
      if (!AsyncResult.isSuccess(result)) return;
      const reply = result.value;
      caption.set(reply.text, reply.done ? CAPTION_LINGER_MS : undefined);
      if (reply.text) {
        replySpeaker.feed({
          registry: input.registry,
          environmentId: input.environmentId,
          messageId,
          text: reply.text,
          streaming: !reply.done,
          front: true,
        });
      }
      if (reply.done) {
        if (reply.firstTokenMs !== null)
          console.info(`[voice] front first token: ${Math.round(reply.firstTokenMs)} ms`);
        settle(reply.answered && reply.text.length > 0);
      }
    },
    { immediate: true },
  );
}
