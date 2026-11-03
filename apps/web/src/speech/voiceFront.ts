import { environmentDisplayLabel } from "@t3tools/client-runtime/state/presentation";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";
import { useSyncExternalStore } from "react";

import { environmentPresentations } from "../state/presentation";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { speechEnvironment } from "../state/speech";
import { replySpeaker } from "./replySpeaker";
import { createAckRotation, needsAck } from "./voiceAck";
import { frontNotSetUp, notSetUpNotice } from "./voiceFrontSetup";

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
const nextAck = createAckRotation();
/** Other machines whose missing quick voice the user already heard about this session. */
const toldNotSetUp = new Set<EnvironmentId>();

/**
 * The notice for a thread on another machine whose quick voice is not set up,
 * the first time only. This machine's own setup is the user's choice, so it
 * stays quiet. The turn still goes to the agent, whose reply is read.
 */
function takeNotSetUpNotice(registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) {
  if (toldNotSetUp.has(environmentId)) return null;
  // With no local server (the hosted web app), every environment is another machine.
  if (registry.get(primaryEnvironmentIdAtom) === environmentId) return null;
  toldNotSetUp.add(environmentId);
  const presentation = registry.get(environmentPresentations.presentationAtom(environmentId));
  return notSetUpNotice(
    presentation === null ? "that machine" : environmentDisplayLabel(presentation),
  );
}

/** What the front voice is saying, or "" when it is quiet. */
export function useFrontCaption() {
  return useSyncExternalStore(caption.subscribe, caption.get);
}

/**
 * Asks the environment's front voice for a quick spoken reply to a just-sent
 * voice turn and plays it as it streams. The agent's reply waits for the verdict
 * and is skipped if the front fully answered; any front failure falls back to
 * reading it. `endOfSpeechAt` is `performance.now()` at turn end, for latency logs.
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
  /** Everything the front has said this turn. */
  let spoken = "";
  /** The front spoke in audio of its own (Gemini). */
  let heardAudio = false;
  const timeout = setTimeout(() => {
    if (!settled) settle(false);
  }, FRONT_DECISION_TIMEOUT_MS);
  /** `answered`: the front fully answered, so the agent's reply stays quiet this turn. */
  const settle = (answered: boolean) => {
    settled = true;
    clearTimeout(timeout);
    // An audio stream that ended without saying so must not keep playback open.
    if (heardAudio) replySpeaker.feedAudio({ messageId, chunks: [], done: true });
    // The agent takes the turn and nothing was said yet: say so before it starts working.
    if (needsAck({ answered, spoken, heardAudio }))
      replySpeaker.feed({
        registry: input.registry,
        environmentId: input.environmentId,
        messageId: `voice-ack:${turnId}`,
        text: nextAck(),
        streaming: false,
        front: true,
      });
    replySpeaker.releaseFront(answered);
    // Unsubscribing inside the callback would end the stream it is delivering.
    queueMicrotask(() => unsubscribe?.());
  };
  unsubscribe = input.registry.subscribe(
    atom,
    (result) => {
      if (settled) return;
      if (AsyncResult.isFailure(result)) {
        const notice = frontNotSetUp(result.cause)
          ? takeNotSetUpNotice(input.registry, input.environmentId)
          : null;
        caption.set(notice ?? "", notice === null ? undefined : CAPTION_LINGER_MS);
        if (notice !== null) {
          // Said in place of the acknowledgement, before the agent's reply.
          spoken = notice;
          replySpeaker.feed({
            registry: input.registry,
            environmentId: input.environmentId,
            messageId: `voice-front-setup:${turnId}`,
            text: notice,
            streaming: false,
            front: true,
          });
        }
        settle(false);
        return;
      }
      if (!AsyncResult.isSuccess(result)) return;
      const reply = result.value;
      if (reply.interrupted) {
        // The user talked over Gemini: silence it now.
        replySpeaker.stop();
        caption.set("");
        settle(false);
        return;
      }
      if (reply.audio && reply.audio.length > 0) {
        heardAudio = true;
        replySpeaker.feedAudio({ messageId, chunks: reply.audio, done: reply.done });
      }
      caption.set(reply.text, reply.done ? CAPTION_LINGER_MS : undefined);
      if (reply.text) {
        spoken = reply.text;
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
        settle(reply.answered && (reply.text.length > 0 || heardAudio));
      }
    },
    { immediate: true },
  );
}
