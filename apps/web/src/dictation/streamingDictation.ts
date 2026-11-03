import {
  type AtomCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  throwIfVoiceTranscriptionAborted,
  VoiceTranscriptionError,
  type VoiceInputControllerDependencies,
  type VoiceInputState,
  type VoiceRecorder,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import type { DictationSessionId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Base64 from "effect/encoding/Base64";
import type { AtomRegistry } from "effect/reactivity";

import { dictationEnvironment } from "../state/dictation";
import { createDictationLevel, type DictationLevel } from "./dictationLevel";
import { PcmCapture } from "./pcmCapture";

/** Under the environment's one-minute idle expiry, with room for a slow round trip. */
const SESSION_REFRESH_AFTER_MS = 30_000;

type DictationSession = {
  readonly environmentId: EnvironmentId;
  /** Null until the environment answers `dictationStart`; frames wait in `pending` until then. */
  sessionId: DictationSessionId | null;
  /** Frames captured before the session existed, sent in order once it does. */
  readonly pending: ArrayBuffer[];
  /** Chunks sent so far; also the next chunk's `seq`. */
  chunks: number;
  /** The newest chunk whose answer carried live text, so late answers cannot roll it back. */
  partialSeq: number;
  /** Live text last handed to `showPartial`. */
  partial: string;
  /** Hands-free turn events already reported, so each fires once. */
  speaking: boolean;
  endOfTurn: boolean;
  /** False once the server has finished or been told to cancel. */
  open: boolean;
  /** Settles after `sessionId` is set and `pending` is flushed, or with the start failure. */
  readonly ready: Promise<string | null>;
  /** Settles with the reason the first chunk was lost, so finishing does not wait on it. */
  readonly lost: Promise<string>;
  readonly loseChunk: (message: string) => void;
};

/** Rejects once `signal` aborts, for racing work that cannot be cancelled itself. */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = () =>
      reject(new VoiceTranscriptionError("cancelled", "Voice transcription was cancelled."));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The environment did not respond.";
}

/**
 * Streams mic audio into one environment's dictation session for a
 * `VoiceInputController`. The permission step opens the mic while requesting the
 * session, buffering frames meanwhile, so nothing said right after the click is
 * lost. Feed every controller state to `settle`; leaving the active phases cleans up.
 */
export function createStreamingDictation(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  /** Read when dictation starts; later changes do not move a running session. */
  readonly resolveEnvironmentId: () => EnvironmentId | null;
  /** Receives the controller's `interruptRecording` message when the session is lost. */
  readonly interrupt: (message: string) => void;
  /** Called after the recording cap stopped capture, like a native recorder's finished status. */
  readonly finishedAtLimit: (uri: string) => void;
  /** Applied to each transcript before it is inserted, e.g. to turn spoken skill names into chips. */
  readonly rewriteTranscript: (text: string) => string;
  /**
   * Live text heard so far, called only when it changes; "" clears it. It is
   * provisional: the transcript `transcribe` returns is what gets inserted.
   */
  readonly showPartial: (text: string) => void;
  /** Read when a session starts: ask the environment to hear the end of the turn. */
  readonly handsFree: () => boolean;
  /** Read when a hands-free session starts: the thread a live voice front (Gemini) hears it for. */
  readonly voiceThreadId: () => ThreadId | null;
  /** Hands-free only: the user started speaking. */
  readonly onSpeechStart: () => void;
  /** Hands-free only: a spoken reply is playing now, so its echo may reach the microphone. */
  readonly playback: () => boolean;
  /** Hands-free only: the user stopped speaking long enough to end the turn, heard at `at` (`performance.now()`). */
  readonly onEndOfTurn: (at: number) => void;
}): {
  readonly dependencies: Omit<
    VoiceInputControllerDependencies,
    "readDraft" | "commitDraft" | "onStateChange"
  >;
  readonly settle: (state: VoiceInputState) => void;
  readonly level: DictationLevel;
  /** True once the current dictation has captured any audio. */
  readonly capturedAudio: () => boolean;
} {
  const capture = new PcmCapture();
  const level = createDictationLevel();
  let session: DictationSession | null = null;
  let limitTimer: ReturnType<typeof setTimeout> | null = null;

  const run = <W, A, E>(command: AtomCommand<W, A, E>, value: W) =>
    runAtomCommand(input.registry, command, value, { reportFailure: false });

  const cancelOnServer = (environmentId: EnvironmentId, sessionId: DictationSessionId) =>
    void run(dictationEnvironment.cancel, { environmentId, input: { sessionId } });

  /** Closes a session; one still starting is cancelled once the environment answers. */
  const close = (target: DictationSession | null) => {
    if (!target?.open) return;
    target.open = false;
    target.pending.length = 0;
    if (target.sessionId !== null) cancelOnServer(target.environmentId, target.sessionId);
  };

  const clearLimit = () => {
    if (limitTimer !== null) clearTimeout(limitTimer);
    limitTimer = null;
  };

  const sendChunk = (target: DictationSession, frame: ArrayBuffer) => {
    if (!target.open) return;
    if (target.sessionId === null) {
      target.pending.push(frame);
      return;
    }
    const sessionId = target.sessionId;
    const seq = target.chunks;
    target.chunks += 1;
    void run(dictationEnvironment.append, {
      environmentId: target.environmentId,
      input: {
        sessionId,
        seq,
        pcm: Base64.encode(new Uint8Array(frame)),
        // Only hands-free sessions read it; the environment ignores it otherwise.
        ...(input.playback() ? { playback: true } : {}),
      },
    }).then((result) => {
      if (!target.open) return;
      if (result._tag !== "Failure") {
        // Turn flags only ever turn on, so any answer may report them.
        const answer = result.value;
        if (answer && session === target) {
          if (answer.speaking && !target.speaking) {
            target.speaking = true;
            input.onSpeechStart();
          }
          if (answer.endOfTurn && !target.endOfTurn) {
            target.endOfTurn = true;
            input.onEndOfTurn(performance.now());
          }
        }
        // Answers can arrive out of order; only a newer chunk's text may replace the shown one.
        const partial = answer?.partial;
        if (partial === undefined || seq < target.partialSeq || session !== target) return;
        target.partialSeq = seq;
        if (partial === target.partial) return;
        target.partial = partial;
        input.showPartial(partial);
        return;
      }
      const message = `Dictation stopped: ${failureMessage(result)}`;
      target.loseChunk(message);
      if (session === target) input.interrupt(message);
    });
  };

  /** Asks the environment for a session; frames captured meanwhile queue on it. */
  const begin = (environmentId: EnvironmentId): DictationSession => {
    const handsFree = input.handsFree();
    const voiceThreadId = handsFree ? input.voiceThreadId() : null;
    const pending: ArrayBuffer[] = [];
    let loseChunk: (message: string) => void = () => undefined;
    const lost = new Promise<string>((resolve) => {
      loseChunk = resolve;
    });
    const target: DictationSession = {
      lost,
      loseChunk,
      environmentId,
      sessionId: null,
      pending,
      chunks: 0,
      partialSeq: -1,
      partial: "",
      speaking: false,
      endOfTurn: false,
      open: true,
      ready: run(dictationEnvironment.start, {
        environmentId,
        input: { handsFree, ...(voiceThreadId === null ? {} : { voiceThreadId }) },
      }).then((started) => {
        if (started._tag === "Failure") return failureMessage(started);
        const { sessionId } = started.value;
        if (!target.open) {
          cancelOnServer(environmentId, sessionId);
          return null;
        }
        target.sessionId = sessionId;
        for (const frame of pending.splice(0)) sendChunk(target, frame);
        return null;
      }),
    };
    return target;
  };

  const sessionUri = (target: DictationSession) => `dictation:${target.sessionId ?? "pending"}`;

  const transcriber: VoiceTranscriber = {
    prepare: async ({ signal }) => {
      const current = session;
      if (current === null) {
        throw new VoiceTranscriptionError("unavailable", "No environment can transcribe.");
      }
      // A start that never answers must not hold dictation open after a cancel.
      const failure = await Promise.race([current.ready, rejectOnAbort(signal)]);
      if (failure !== null) throw new VoiceTranscriptionError("preparation-failed", failure);
      const sessionId = current.sessionId;
      if (signal.aborted || sessionId === null) close(current);
      if (sessionId === null) {
        throw new VoiceTranscriptionError("cancelled", "Voice transcription was cancelled.");
      }
      throwIfVoiceTranscriptionAborted(signal);
      signal.addEventListener("abort", () => close(current), { once: true });
      return {
        // Replaced by the locale the environment reports with the transcript.
        locale: "en",
        transcribe: async (_uri, options) => {
          throwIfVoiceTranscriptionAborted(options.signal);
          // A lost chunk would leave the environment waiting for it, so fail at once instead.
          const finished = await Promise.race([
            run(dictationEnvironment.finish, {
              environmentId: current.environmentId,
              input: { sessionId, chunkCount: current.chunks },
            }),
            current.lost.then((message) => {
              throw new VoiceTranscriptionError("transcription-failed", message);
            }),
            rejectOnAbort(options.signal),
          ]);
          if (finished._tag === "Failure") {
            throw new VoiceTranscriptionError("transcription-failed", failureMessage(finished));
          }
          current.open = false;
          return { ...finished.value, text: input.rewriteTranscript(finished.value.text) };
        },
      };
    },
  };

  const recorder: VoiceRecorder = {
    get uri() {
      return session === null ? null : sessionUri(session);
    },
    prepareToRecordAsync: async () => undefined,
    // Capture already runs from the permission step; this only arms the recording cap.
    record: ({ forDuration }) => {
      const current = session;
      if (current === null) throw new Error("No dictation session is open.");
      clearLimit();
      limitTimer = setTimeout(() => {
        limitTimer = null;
        void capture.stop().then(() => input.finishedAtLimit(sessionUri(current)));
      }, forDuration * 1_000);
    },
    stop: async () => {
      clearLimit();
      await capture.stop();
      level.set(0);
    },
  };

  return {
    dependencies: {
      recorder,
      getTranscriber: () => (input.resolveEnvironmentId() === null ? null : transcriber),
      // Opening the microphone is the browser's permission prompt. The session
      // request goes out first so the network round trip overlaps it, and
      // capture starts the moment the microphone is live.
      requestPermission: async () => {
        const environmentId = input.resolveEnvironmentId();
        close(session);
        session = environmentId === null ? null : begin(environmentId);
        const askedAt = Date.now();
        const access = await capture.open();
        if (!access.granted) {
          return { granted: false, canAskAgain: true, message: access.message };
        }
        // The environment ends sessions that stay silent for a minute. Someone who
        // took a while over the first-use microphone prompt gets a fresh one, so
        // dictation carries on once they allow access.
        if (environmentId !== null && Date.now() - askedAt > SESSION_REFRESH_AFTER_MS) {
          close(session);
          session = begin(environmentId);
        }
        await capture.prepare();
        const current = session;
        capture.start((frame) => {
          if (current !== null) sendChunk(current, frame);
        }, level.set);
        return { granted: true, canAskAgain: true };
      },
      // The permission step already loaded the worklet and started capture.
      configureRecording: async () => undefined,
      releaseRecording: async () => capture.release(),
      // Nothing is stored locally; `settle` cancels a session that never finished.
      deleteRecording: () => undefined,
    },
    settle: (state) => {
      if (state.phase !== "idle" && state.phase !== "error") return;
      if (session?.partial) input.showPartial("");
      clearLimit();
      capture.release();
      level.set(0);
      close(session);
      session = null;
    },
    level,
    capturedAudio: () => session !== null && (session.chunks > 0 || session.pending.length > 0),
  };
}
