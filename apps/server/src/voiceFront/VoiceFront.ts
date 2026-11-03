/**
 * VoiceFront - answers a voice turn at once with the one LM Studio model the
 * settings name, size-checked and always with an idle TTL so LM Studio unloads
 * it. It never loads or unloads models itself, but starts a stopped server.
 * With the Gemini engine, Gemini's spoken answer wins and this is the fallback.
 */
import {
  type ThreadId,
  VOICE_FRONT_MAX_MODEL_BYTES,
  VoiceFrontError,
  type VoiceFrontReply,
  type VoiceFrontRespondInput,
  type VoiceFrontSettings,
  type VoiceFrontStatus,
} from "@t3tools/contracts";
import * as NodeOS from "node:os";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GeminiLive from "./GeminiLive.ts";
import type { LiveTurn, TurnEvent } from "./LiveSession.ts";
import { chatMessages, parseFrontOutput } from "./frontPrompt.ts";
import {
  checkModel,
  decodeModelList,
  isLocalEndpoint,
  LMS_PATH_SEGMENTS,
  lmsEnv,
  sseDelta,
} from "./LmStudio.ts";
import * as VoiceFrontContext from "./VoiceFrontContext.ts";

/** LM Studio unloads the front model after this long without a request. */
export const VOICE_FRONT_IDLE_TTL_SECONDS = 600;
/** Enough for two short sentences and the tag. */
const MAX_REPLY_TOKENS = 90;
/** A size check stays good this long, so turns do not each run `lms ls`. */
const SIZE_CHECK_TTL_MS = 60_000;
/** Longest wait for Gemini's first word before the local front answers instead. */
const GEMINI_FIRST_AUDIO_TIMEOUT_MS = 8_000;

export class VoiceFront extends Context.Service<
  VoiceFront,
  {
    readonly status: Effect.Effect<VoiceFrontStatus, VoiceFrontError>;
    readonly respond: (
      input: VoiceFrontRespondInput,
    ) => Stream.Stream<VoiceFrontReply, VoiceFrontError>;
    /** Hands-free voice ended in this thread. */
    readonly end: (threadId: ThreadId) => Effect.Effect<void>;
    readonly setGeminiKey: (key: string | null) => Effect.Effect<void, VoiceFrontError>;
  }
>()("t3/voiceFront/VoiceFront") {}

const failed = (reason: VoiceFrontError["reason"], message: string, cause?: unknown) =>
  new VoiceFrontError({ reason, message, ...(cause === undefined ? {} : { cause }) });

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const http = yield* HttpClient.HttpClient;
  const processes = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const contexts = yield* VoiceFrontContext.VoiceFrontContext;
  const gemini = yield* GeminiLive.GeminiLive;
  const lmsPath = (yield* Path.Path).join(NodeOS.homedir(), ...LMS_PATH_SEGMENTS);
  const isVoiceFrontError = Schema.is(VoiceFrontError);
  let checked: { readonly model: string; readonly sizeBytes: number; readonly at: number } | null =
    null;

  const readSettings = settings.getSettings.pipe(
    Effect.map((current) => current.voiceFront),
    Effect.mapError((cause) => failed("disabled", "Could not read voice settings.", cause)),
  );

  const lms = (args: ReadonlyArray<string>, timeout: `${number} seconds`) =>
    processes
      .run({ command: lmsPath, args, env: lmsEnv(), timeout, maxOutputBytes: 4 * 1024 * 1024 })
      .pipe(Effect.mapError((cause) => failed("server-unavailable", "Could not run lms.", cause)));

  const requireLms = Effect.gen(function* () {
    const installed = yield* fs.exists(lmsPath).pipe(Effect.orElseSucceed(() => false));
    if (!installed)
      return yield* failed(
        "lm-studio-missing",
        "LM Studio is not installed. Install it from lmstudio.ai, then download the model with lms get.",
      );
  });

  const reachable = (endpoint: string) =>
    http.execute(HttpClientRequest.get(`${endpoint}/models`)).pipe(
      Effect.map((response) => response.status === 200),
      Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.succeed(false) }),
      Effect.orElseSucceed(() => false),
    );

  /** Starts LM Studio's server when it is down, then waits for it to answer. */
  const ensureServer = Effect.fnUntraced(function* (endpoint: string) {
    if (yield* reachable(endpoint)) return;
    yield* Effect.logInfo("Starting LM Studio's server for the front voice.");
    yield* lms(["server", "start"], "60 seconds").pipe(Effect.ignore);
    const up = yield* reachable(endpoint).pipe(
      Effect.repeat({ until: (ok) => ok, schedule: Schedule.spaced("500 millis"), times: 40 }),
    );
    if (!up)
      return yield* failed(
        "server-unavailable",
        "LM Studio's server did not start. Open LM Studio, or run: lms server start",
      );
  });

  /** The size guard: the configured model must be downloaded and under the cap. */
  const checkSize = Effect.fnUntraced(function* (model: string) {
    const now = yield* Clock.currentTimeMillis;
    if (checked?.model === model && now - checked.at < SIZE_CHECK_TTL_MS) return checked.sizeBytes;
    const output = yield* lms(["ls", "--json"], "20 seconds");
    const models = yield* decodeModelList(output.stdout).pipe(
      Effect.mapError((cause) =>
        failed("model-missing", "Could not read LM Studio's model list.", cause),
      ),
    );
    const result = checkModel(models, model, VOICE_FRONT_MAX_MODEL_BYTES);
    if (isVoiceFrontError(result)) return yield* result;
    checked = { model, sizeBytes: result.sizeBytes, at: now };
    return result.sizeBytes;
  });

  const prepare = Effect.fnUntraced(function* (current: VoiceFrontSettings) {
    if (!current.enabled)
      return yield* failed("disabled", "Turn on the front voice in Spoken replies settings.");
    // Only a server on this machine can be sized by `lms`, so the guard holds.
    if (!isLocalEndpoint(current.endpoint))
      return yield* failed(
        "server-unavailable",
        "The front voice only uses LM Studio on this machine (127.0.0.1 or localhost).",
      );
    yield* requireLms;
    yield* ensureServer(current.endpoint);
    return yield* checkSize(current.model);
  });

  const status = Effect.gen(function* () {
    const current = yield* readSettings;
    const base = {
      settings: current,
      maxModelBytes: VOICE_FRONT_MAX_MODEL_BYTES,
      gemini: yield* gemini.status,
    };
    if (!current.enabled) return { ...base, problem: null, modelBytes: null };
    // Status never starts anything: a stopped server is fine, the next turn starts it.
    const problem = yield* Effect.gen(function* () {
      if (!isLocalEndpoint(current.endpoint))
        return yield* failed("server-unavailable", "Use LM Studio on this machine.");
      yield* requireLms;
      if (!(yield* reachable(current.endpoint))) return { modelBytes: null };
      return { modelBytes: yield* checkSize(current.model) };
    }).pipe(
      Effect.map((result) => ({ ...result, problem: null })),
      Effect.catchTags({
        VoiceFrontError: (error) => Effect.succeed({ problem: error.message, modelBytes: null }),
      }),
    );
    return { ...base, ...problem };
  });

  const respondLocally = (input: VoiceFrontRespondInput) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const current = yield* readSettings;
        yield* prepare(current);
        const context = yield* contexts.load(input.threadId);
        const startedAt = yield* Clock.currentTimeMillis;
        const response = yield* http
          .execute(
            HttpClientRequest.post(`${current.endpoint}/chat/completions`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                model: current.model,
                messages: chatMessages(context, input.transcript),
                stream: true,
                temperature: 0.3,
                max_tokens: MAX_REPLY_TOKENS,
                // LM Studio unloads a just-in-time loaded model after this many idle seconds.
                ttl: VOICE_FRONT_IDLE_TTL_SECONDS,
              }),
            ),
          )
          .pipe(
            // Covers loading the model the first time.
            Effect.timeoutOrElse({
              duration: "45 seconds",
              orElse: () =>
                Effect.fail(failed("generation-failed", "LM Studio did not answer in time.")),
            }),
            Effect.mapError((cause) =>
              isVoiceFrontError(cause)
                ? cause
                : failed("generation-failed", "Could not reach LM Studio.", cause),
            ),
          );
        if (response.status !== 200) {
          const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
          return yield* failed(
            "generation-failed",
            `LM Studio refused the request (${response.status}).`,
            body.slice(0, 500),
          );
        }
        let raw = "";
        let firstTokenMs: number | null = null;
        let last: VoiceFrontReply | null = null;
        const finish = Effect.gen(function* () {
          const parsed = parseFrontOutput(raw);
          const reply: VoiceFrontReply = {
            ...parsed,
            text: parsed.text.trim(),
            done: true,
            firstTokenMs,
          };
          yield* Effect.logInfo("Front voice replied.").pipe(
            Effect.annotateLogs({
              firstTokenMs,
              totalMs: (yield* Clock.currentTimeMillis) - startedAt,
              answered: reply.answered,
            }),
          );
          return reply;
        });
        return response.stream.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.map(sseDelta),
          Stream.takeWhile((delta) => delta !== "done"),
          Stream.mapEffect((delta) =>
            Effect.gen(function* () {
              if (typeof delta !== "string" || delta.length === 0) return null;
              if (firstTokenMs === null)
                firstTokenMs = (yield* Clock.currentTimeMillis) - startedAt;
              raw += delta;
              const parsed = parseFrontOutput(raw);
              // Only new words are worth an update; the held-back tag is not.
              if (parsed.text === (last?.text ?? "")) return null;
              last = { ...parsed, done: false, firstTokenMs };
              return last;
            }),
          ),
          Stream.filter((reply): reply is VoiceFrontReply => reply !== null),
          Stream.concat(Stream.fromEffect(finish)),
          Stream.mapError((cause) =>
            isVoiceFrontError(cause)
              ? cause
              : failed("generation-failed", "The front voice's reply was interrupted.", cause),
          ),
        );
      }),
    );

  /** The local reply, opened with `notice` when the user should hear why it is not Gemini. */
  const localWithNotice = (input: VoiceFrontRespondInput, notice: string | null) =>
    notice === null
      ? respondLocally(input)
      : respondLocally(input).pipe(
          Stream.map((reply) => ({ ...reply, text: `${notice} ${reply.text}`.trim() })),
          // With no local front either, the notice is still said.
          Stream.catch(() =>
            Stream.succeed<VoiceFrontReply>({
              text: notice,
              done: true,
              answered: false,
              firstTokenMs: null,
            }),
          ),
        );

  /** Gemini's spoken answer, or the local one if it fails before saying anything. */
  const fromTurn = (input: VoiceFrontRespondInput, turn: LiveTurn, startedAt: number) => {
    let heard = false;
    let handedOff = false;
    let firstTokenMs: number | null = null;
    const reply = (fields: Partial<VoiceFrontReply>): VoiceFrontReply => ({
      text: "",
      done: false,
      answered: false,
      firstTokenMs,
      ...fields,
    });
    const events = Stream.callback<TurnEvent>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => turn.subscribe((event) => Queue.offerUnsafe(queue, event))),
        (unsubscribe) => Effect.sync(unsubscribe),
      ),
    );
    return events.pipe(
      Stream.timeoutOrElse({
        duration: `${GEMINI_FIRST_AUDIO_TIMEOUT_MS} millis`,
        orElse: () =>
          Stream.succeed<TurnEvent>({ type: "failed", message: "Gemini did not answer in time." }),
      }),
      Stream.flatMap((event: TurnEvent): Stream.Stream<VoiceFrontReply, VoiceFrontError> => {
        switch (event.type) {
          case "audio":
            heard = true;
            return Stream.fromEffect(
              Effect.map(Clock.currentTimeMillis, (nowMs) => {
                firstTokenMs ??= nowMs - startedAt;
                return reply({ audio: [event.data] });
              }),
            );
          case "handoff":
            handedOff = true;
            return Stream.empty;
          case "interrupted":
            return Stream.succeed(reply({ done: true, interrupted: true }));
          case "done":
            return Stream.succeed(reply({ done: true, answered: heard && !handedOff }));
          case "failed":
            if (heard) return Stream.succeed(reply({ done: true }));
            return Stream.unwrap(
              Effect.map(gemini.notice("failed"), (notice) => localWithNotice(input, notice)),
            );
        }
      }),
      Stream.takeUntil((value) => value.done),
    );
  };

  const respond = (input: VoiceFrontRespondInput) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const current = yield* readSettings;
        if (!current.enabled || current.engine !== "gemini") return respondLocally(input);
        const startedAt = yield* Clock.currentTimeMillis;
        const claimed = yield* gemini.claim(input.threadId);
        return claimed._tag === "turn"
          ? fromTurn(input, claimed.turn, startedAt)
          : localWithNotice(input, claimed.notice);
      }),
    );

  return VoiceFront.of({ status, respond, end: gemini.end, setGeminiKey: gemini.setKey });
});

export const layer = Layer.effect(VoiceFront, make);
