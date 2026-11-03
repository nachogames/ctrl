/**
 * Apple's on-device speech recognition through the `ctrl-apple-speech` helper,
 * one process per session (ready in ~300 ms, so no warm pool). The helper is at
 * `T3CODE_APPLE_SPEECH_PATH` in the packaged app, or built with `swiftc` on first
 * use in a checkout into the gitignored `native/apple-speech/.build`.
 */
import { DictationError, type DictationFinishResult } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Ndjson from "effect/encoding/Ndjson";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { joinTexts } from "./audio.ts";

const HELPER_NAME = "ctrl-apple-speech";

const LanguageOption = Schema.Struct({ code: Schema.String, label: Schema.String });

export const HelperEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("probe"),
    available: Schema.Boolean,
    reason: Schema.optionalKey(Schema.String),
    locale: Schema.optionalKey(Schema.String),
    assets: Schema.Literals(["installed", "downloading", "supported", "unsupported"]),
    locales: Schema.Array(LanguageOption),
  }),
  Schema.Struct({
    type: Schema.Literal("progress"),
    completed: Schema.Number,
    total: Schema.Number,
  }),
  Schema.Struct({ type: Schema.Literal("installed"), locale: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("ready"), locale: Schema.String }),
  Schema.Struct({ type: Schema.Literal("partial"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("final"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("done") }),
  Schema.Struct({ type: Schema.Literal("error"), code: Schema.String, message: Schema.String }),
]);
export type HelperEvent = typeof HelperEvent.Type;
const decodeEvent = Schema.decodeUnknownEffect(HelperEvent);
const encodeContext = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ words: Schema.Array(Schema.String) })),
);

/** One stdin frame: a kind byte, a little-endian u32 payload length, then the payload. */
export function encodeFrame(kind: "C" | "A" | "E", payload: Uint8Array = new Uint8Array()) {
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = kind.charCodeAt(0);
  new DataView(frame.buffer).setUint32(1, payload.length, true);
  frame.set(payload, 5);
  return frame;
}

/** Float samples in [-1, 1] back to the helper's little-endian int16 PCM. */
export function encodePcm16(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(i * 2, Math.round(sample * 32767), true);
  }
  return bytes;
}

export interface AppleProbe {
  readonly available: boolean;
  readonly reason: string | null;
  readonly locale: string | null;
  readonly assets: "installed" | "downloading" | "supported" | "unsupported";
  readonly languageOptions: ReadonlyArray<{ readonly code: string; readonly label: string }>;
}

const unavailable = (reason: string | null): AppleProbe => ({
  available: false,
  reason,
  locale: null,
  assets: "unsupported",
  languageOptions: [],
});

export interface AppleTranscription {
  /** Queue int16 PCM in recording order. */
  readonly write: (pcm: Uint8Array) => Effect.Effect<void, DictationError>;
  /** Text heard so far: finalized phrases plus the current phrase's volatile text. */
  readonly partial: Effect.Effect<string>;
  /** End the utterance and wait for its final text. */
  readonly finish: Effect.Effect<DictationFinishResult, DictationError>;
  /** Stop the helper; safe to call more than once. */
  readonly close: Effect.Effect<void>;
}

export class AppleSpeech extends Context.Service<
  AppleSpeech,
  {
    /** Never fails: any problem reads as unavailable with a reason. */
    readonly probe: (language: string) => Effect.Effect<AppleProbe>;
    /** Downloads Apple's on-device assets for the language, reporting unit progress. */
    readonly install: (
      language: string,
      progress: (completed: number, total: number) => Effect.Effect<void>,
    ) => Effect.Effect<void, DictationError>;
    readonly open: (input: {
      readonly language: string;
      readonly words: ReadonlyArray<string>;
    }) => Effect.Effect<AppleTranscription, DictationError>;
  }
>()("t3/dictation/AppleSpeech") {}

const failed = (message: string, cause?: unknown) =>
  new DictationError({
    reason: "transcription-failed",
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const helperError = (event: { code: string; message: string }) =>
  new DictationError({
    reason:
      event.code === "assets"
        ? "install-failed"
        : event.code === "unavailable" || event.code === "unsupported-locale"
          ? "unsupported-platform"
          : "transcription-failed",
    message: event.message,
  });

/** Runs one helper command over an already-resolved binary; split out so tests drive a fake process. */
export const makeWithBinary = Effect.fnUntraced(function* (
  binary: Effect.Effect<string, DictationError>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const spawn = Effect.fn("AppleSpeech.spawn")(function* (
    args: ReadonlyArray<string>,
    scope: Scope.Scope,
  ) {
    const executable = yield* binary;
    return yield* spawner
      .spawn(
        ChildProcess.make(executable, [...args], {
          stdin: { stream: "pipe", endOnDone: false },
          stdout: "pipe",
          stderr: "pipe",
          killSignal: "SIGTERM",
          forceKillAfter: Duration.seconds(2),
        }),
      )
      .pipe(
        Scope.provide(scope),
        Effect.mapError((cause) => failed("Could not start Apple speech recognition.", cause)),
      );
  });

  const events = (handle: ChildProcessSpawner.ChildProcessHandle) =>
    handle.stdout.pipe(
      Stream.pipeThroughChannel(Ndjson.decode({ ignoreEmptyLines: true })),
      Stream.mapEffect((value) => decodeEvent(value)),
      Stream.mapError(() => failed("Apple speech recognition sent an invalid event.")),
    );

  /** Runs a command to completion, handing each event to `onEvent`. */
  const run = <A>(
    args: ReadonlyArray<string>,
    onEvent: (event: HelperEvent) => Effect.Effect<Option.Option<A>, DictationError>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawn(args, yield* Effect.scope);
        yield* handle.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);
        let result = Option.none<A>();
        yield* events(handle).pipe(
          Stream.runForEach((event) =>
            event.type === "error"
              ? Effect.fail(helperError(event))
              : onEvent(event).pipe(
                  Effect.map((value) => {
                    if (Option.isSome(value)) result = value;
                  }),
                ),
          ),
        );
        return result;
      }),
    );

  const languageArgs = (language: string) => ["--locale", language || "auto"];

  const probe = (language: string) =>
    run(["probe", ...languageArgs(language)], (event) =>
      Effect.succeed(
        event.type === "probe"
          ? Option.some<AppleProbe>({
              available: event.available,
              reason: event.reason ?? null,
              locale: event.locale ?? null,
              assets: event.assets,
              languageOptions: event.locales,
            })
          : Option.none(),
      ),
    ).pipe(
      Effect.map(Option.getOrElse(() => unavailable("Apple speech recognition did not respond."))),
      Effect.catchTags({ DictationError: (error) => Effect.succeed(unavailable(error.message)) }),
      Effect.timeoutOrElse({
        duration: "20 seconds",
        orElse: () => Effect.succeed(unavailable("Apple speech recognition did not respond.")),
      }),
    );

  const install = (
    language: string,
    progress: (completed: number, total: number) => Effect.Effect<void>,
  ) =>
    run(["install", ...languageArgs(language)], (event) =>
      event.type === "progress"
        ? progress(event.completed, event.total).pipe(Effect.as(Option.none()))
        : Effect.succeedNone,
    ).pipe(Effect.asVoid);

  const open = Effect.fnUntraced(function* (input: {
    readonly language: string;
    readonly words: ReadonlyArray<string>;
  }) {
    const scope = yield* Scope.make();
    const handle = yield* spawn(["transcribe", ...languageArgs(input.language)], scope).pipe(
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
    const texts: string[] = [];
    /** Volatile text of the phrase being spoken, replaced by its "final". */
    let volatile = "";
    let locale = input.language === "auto" || !input.language ? "en" : input.language;
    let error: DictationError | null = null;
    const done = yield* Deferred.make<void, DictationError>();
    yield* handle.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkIn(scope));
    yield* events(handle).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (event.type === "ready") locale = event.locale;
          else if (event.type === "partial") volatile = event.text;
          else if (event.type === "final") {
            volatile = "";
            if (event.text.trim()) texts.push(event.text.trim());
          } else if (event.type === "done") yield* Deferred.succeed(done, undefined);
          else if (event.type === "error") {
            error = helperError(event);
            yield* Deferred.fail(done, error);
          }
        }),
      ),
      Effect.catch((cause) => Deferred.fail(done, cause)),
      // A helper that exits without "done" crashed or was killed.
      Effect.andThen(Deferred.fail(done, failed("Apple speech recognition stopped unexpectedly."))),
      Effect.forkIn(scope),
    );
    const send = (frame: Uint8Array) =>
      Effect.suspend(() =>
        error
          ? Effect.fail(error)
          : Stream.run(Stream.make(frame), handle.stdin).pipe(
              Effect.mapError((cause) =>
                failed("Could not send audio to Apple speech recognition.", cause),
              ),
            ),
      );
    if (input.words.length > 0) {
      yield* send(
        encodeFrame("C", new TextEncoder().encode(encodeContext({ words: input.words }))),
      ).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
    }
    return {
      write: (pcm) => send(encodeFrame("A", pcm)),
      partial: Effect.sync(() => joinTexts([...texts, volatile])),
      finish: Effect.gen(function* () {
        yield* send(encodeFrame("E"));
        yield* Deferred.await(done).pipe(
          Effect.timeoutOrElse({
            duration: "30 seconds",
            orElse: () => Effect.fail(failed("Apple speech recognition did not finish.")),
          }),
        );
        return { text: joinTexts(texts), locale };
      }),
      close: Scope.close(scope, Exit.void),
    } satisfies AppleTranscription;
  });

  return AppleSpeech.of({ probe, install, open });
});

/**
 * Resolves the helper binary once per server. In a checkout it is rebuilt when
 * `main.swift` is newer than the last build, so editing the helper needs no
 * extra step.
 */
const resolveBinary = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const override = environment.T3CODE_APPLE_SPEECH_PATH;
  if (override) return override;
  const exists = (file: string) => fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false));
  // src/dictation in a checkout, or dist next to bin.mjs.
  const sourceDirs = [
    path.resolve(import.meta.dirname, "../../../../native/apple-speech"),
    path.resolve(import.meta.dirname, "../../../native/apple-speech"),
  ];
  for (const dir of sourceDirs) {
    const source = path.join(dir, "main.swift");
    if (!(yield* exists(source))) continue;
    const output = path.join(dir, ".build", HELPER_NAME);
    const modified = (file: string) =>
      fileSystem.stat(file).pipe(
        Effect.map((info) =>
          Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() }),
        ),
        Effect.orElseSucceed(() => 0),
      );
    if ((yield* exists(output)) && (yield* modified(output)) >= (yield* modified(source)))
      return output;
    yield* fileSystem.makeDirectory(path.dirname(output), { recursive: true }).pipe(Effect.ignore);
    yield* Effect.logInfo("Building the Apple speech helper.");
    const exitCode = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(
            "xcrun",
            ["swiftc", "-O", "-swift-version", "5", "-o", output, source],
            { stdout: "ignore", stderr: "pipe" },
          ),
        );
        const stderr = yield* handle.stderr.pipe(Stream.decodeText(), Stream.mkString);
        const code = yield* handle.exitCode;
        if (code !== 0) yield* Effect.logWarning("Apple speech helper build failed.", stderr);
        return code;
      }),
    ).pipe(Effect.orElseSucceed(() => 1));
    if (exitCode === 0) return output;
    return yield* failed("Could not build the Apple speech helper. Install the Xcode tools.");
  }
  return yield* new DictationError({
    reason: "unsupported-platform",
    message: "The Apple speech helper is missing from this install.",
  });
});

export const layer = Layer.effect(
  AppleSpeech,
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    if (platform !== "darwin") {
      const missing = new DictationError({
        reason: "unsupported-platform",
        message: "Apple speech recognition needs a Mac.",
      });
      return AppleSpeech.of({
        probe: Effect.fn("AppleSpeech.probe")(() => Effect.succeed(unavailable(null))),
        install: Effect.fn("AppleSpeech.install")(() => Effect.fail(missing)),
        open: Effect.fn("AppleSpeech.open")(() => Effect.fail(missing)),
      });
    }
    const context = yield* Effect.context<
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
    >();
    const binary = yield* Effect.cached(resolveBinary.pipe(Effect.provide(context)));
    return yield* makeWithBinary(binary);
  }),
);

/** An environment without Apple's engine, e.g. for tests of the Parakeet path. */
export const layerUnavailable = Layer.succeed(
  AppleSpeech,
  AppleSpeech.of({
    probe: Effect.fn("AppleSpeech.probe")(() => Effect.succeed(unavailable(null))),
    install: Effect.fn("AppleSpeech.install")(() =>
      Effect.fail(new DictationError({ reason: "unsupported-platform", message: "Unavailable." })),
    ),
    open: Effect.fn("AppleSpeech.open")(() =>
      Effect.fail(new DictationError({ reason: "unsupported-platform", message: "Unavailable." })),
    ),
  }),
);
