import * as NodeUtil from "node:util";
import * as NodeZlib from "node:zlib";
import {
  DictationError,
  type DictationInstallState,
  type DictationModelId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ServerConfig from "../config.ts";
import { models, runtimeFor, speechModel } from "./models.ts";
import { createIntegrityHash } from "./integrity.ts";
import { readTar } from "./tar.ts";

export class DictationArtifacts extends Context.Service<
  DictationArtifacts,
  {
    readonly supported: boolean;
    readonly paths: (model: DictationModelId) => { runtime: string; model: string };
    readonly inspect: Effect.Effect<
      {
        runtime: DictationInstallState;
        models: ReadonlyMap<DictationModelId, DictationInstallState>;
      },
      DictationError
    >;
    readonly install: (
      model: DictationModelId,
      progress: (
        artifact: "runtime" | DictationModelId,
        state: DictationInstallState,
      ) => Effect.Effect<void>,
    ) => Effect.Effect<void, DictationError>;
    readonly remove: (model: DictationModelId) => Effect.Effect<void, DictationError>;
    /** The spoken-reply voice model, which shares the runtime with dictation. */
    readonly speechPaths: { runtime: string; model: string };
    readonly inspectSpeech: Effect.Effect<
      { runtime: DictationInstallState; model: DictationInstallState },
      DictationError
    >;
    readonly installSpeech: (
      progress: (
        artifact: "runtime" | "speech",
        state: DictationInstallState,
      ) => Effect.Effect<void>,
    ) => Effect.Effect<void, DictationError>;
    /** Deletes the voice model only; the runtime stays for dictation. */
    readonly removeSpeech: Effect.Effect<void, DictationError>;
  }
>()("t3/dictation/DictationArtifacts") {}

type Noun = "dictation" | "voice";
type ProgressReport = (state: DictationInstallState) => Effect.Effect<void>;

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const config = yield* ServerConfig.ServerConfig;
  const mutations = yield* Semaphore.make(1);
  const root = path.join(config.stateDir, "dictation");
  const runtime = runtimeFor(yield* HostProcess.Platform, yield* HostProcess.Architecture);
  const runtimePath = path.join(root, "runtime", runtime?.directory ?? "unsupported");
  const paths = (model: DictationModelId) => ({
    runtime: runtimePath,
    model: path.join(root, "models", model),
  });
  const speechPaths = {
    runtime: runtimePath,
    model: path.join(root, "voices", speechModel.directory),
  };
  const io = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
    operation.pipe(
      Effect.mapError(
        (cause) =>
          new DictationError({
            reason: "install-failed",
            message: "Could not access dictation files.",
            cause,
          }),
      ),
    );
  const size = (file: string) =>
    fs.stat(file).pipe(
      Effect.map((info) => (info.type === "File" ? Number(info.size) : null)),
      Effect.catchIf(
        (cause) => cause.reason._tag === "NotFound",
        () => Effect.succeed(null),
      ),
      io,
    );
  const inspectRuntime = Effect.gen(function* () {
    let complete = runtime !== null;
    let bytes = 0;
    for (const name of runtime?.nativeFiles ?? []) {
      const actual = yield* size(path.join(runtimePath, name));
      complete &&= actual !== null && actual > 0;
      bytes += actual ?? 0;
    }
    return complete
      ? ({ _tag: "installed", sizeBytes: bytes } as const)
      : ({ _tag: "not-installed" } as const);
  });
  const inspectFiles = Effect.fnUntraced(function* (
    directory: string,
    files: readonly { name: string; bytes: number }[],
  ) {
    let complete = true;
    let bytes = 0;
    for (const file of files) {
      const actual = yield* size(path.join(directory, file.name));
      complete &&= actual === file.bytes;
      bytes += actual ?? 0;
    }
    return complete
      ? ({ _tag: "installed", sizeBytes: bytes } as const)
      : ({ _tag: "not-installed" } as const);
  });
  const inspect = Effect.gen(function* () {
    const installed = new Map<DictationModelId, DictationInstallState>();
    for (const id of Object.keys(models) as DictationModelId[]) {
      installed.set(id, yield* inspectFiles(paths(id).model, models[id].files));
    }
    return { runtime: yield* inspectRuntime, models: installed };
  });
  const inspectSpeech = Effect.gen(function* () {
    return {
      runtime: yield* inspectRuntime,
      model: yield* inspectFiles(speechPaths.model, speechModel.files),
    };
  });

  // Downloads stream to temporary files. The AbortSignal and finalizer own partial-file cleanup.
  const download = Effect.fnUntraced(function* (
    noun: Noun,
    url: string,
    destination: string,
    algorithm: "sha256" | "sha512",
    expected: string,
    maxBytes: number,
    progress: (received: number, total: number) => Effect.Effect<void>,
  ) {
    const response = yield* http.get(url).pipe(
      Effect.mapError(
        (cause) =>
          new DictationError({
            reason: "install-failed",
            message: `Could not download ${noun} files.`,
            cause,
          }),
      ),
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () =>
          Effect.fail(
            new DictationError({
              reason: "install-failed",
              message: `The ${noun} download timed out.`,
            }),
          ),
      }),
    );
    if (response.status !== 200)
      return yield* new DictationError({
        reason: "install-failed",
        message: `The ${noun} download was unavailable.`,
      });
    const total = Number(response.headers["content-length"]) || maxBytes;
    const file = yield* io(fs.open(destination, { flag: "wx" }));
    const hash = createIntegrityHash(algorithm);
    let received = 0;
    yield* response.stream.pipe(
      Stream.timeout("30 seconds"),
      Stream.mapError(
        (cause) =>
          new DictationError({
            reason: "install-failed",
            message: `The ${noun} download was interrupted.`,
            cause,
          }),
      ),
      Stream.runForEach((bytes) =>
        Effect.gen(function* () {
          received += bytes.length;
          if (received > maxBytes)
            return yield* new DictationError({
              reason: "install-failed",
              message: `The ${noun} download exceeded its expected size.`,
            });
          hash.update(bytes);
          yield* io(file.writeAll(bytes));
          yield* progress(received, total);
        }),
      ),
    );
    if (hash.digest(algorithm === "sha512" ? "base64" : "hex") !== expected)
      return yield* new DictationError({
        reason: "install-failed",
        message: `The ${noun} download failed integrity verification.`,
      });
    return received;
  }, Effect.scoped);

  const atomicInstall = Effect.fnUntraced(function* (
    destination: string,
    write: (temporary: string) => Effect.Effect<void, DictationError, Scope.Scope>,
  ) {
    const temporary = `${destination}.tmp`;
    yield* io(fs.makeDirectory(path.dirname(destination), { recursive: true }));
    // A previous process may have exited before its staging finalizer ran.
    yield* io(fs.remove(temporary, { recursive: true, force: true }));
    yield* Effect.acquireRelease(io(fs.makeDirectory(temporary)), () =>
      fs.remove(temporary, { recursive: true, force: true }).pipe(Effect.orDie),
    );
    yield* write(temporary);
    yield* io(fs.remove(destination, { recursive: true, force: true }));
    yield* io(fs.rename(temporary, destination));
  });

  /** Throttles progress to one report per 250 ms; the caller reports the final state itself. */
  const throttled = (progress: ProgressReport): ProgressReport => {
    let lastProgress = -Infinity;
    return (state) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (now - lastProgress >= 250) {
          yield* progress(state);
          lastProgress = now;
        }
      });
  };

  const unsupported = (noun: Noun) =>
    new DictationError({
      reason: "unsupported-platform",
      message:
        noun === "voice"
          ? "Spoken replies are unavailable on this platform."
          : "Local dictation is unavailable on this platform.",
    });

  const installRuntime = Effect.fnUntraced(function* (noun: Noun, progress: ProgressReport) {
    if (!runtime) return yield* unsupported(noun);
    const current = yield* inspectRuntime;
    if (current._tag === "installed") return yield* progress(current);
    const report = throttled(progress);
    yield* progress({ _tag: "installing", receivedBytes: 0, totalBytes: 0 });
    yield* atomicInstall(runtimePath, (temporary) =>
      Effect.gen(function* () {
        const archive = path.join(temporary, "runtime.tgz");
        yield* download(
          noun,
          runtime.url,
          archive,
          "sha512",
          runtime.integrity,
          128 * 1024 * 1024,
          (receivedBytes, totalBytes) => report({ _tag: "installing", receivedBytes, totalBytes }),
        );
        const compressed = yield* io(fs.readFile(archive));
        const invalid = (cause: unknown) =>
          new DictationError({
            reason: "install-failed",
            message: `The ${noun} runtime archive was invalid.`,
            cause,
          });
        const expanded = yield* Effect.tryPromise({
          try: () =>
            NodeUtil.promisify(NodeZlib.gunzip)(compressed, {
              maxOutputLength: 512 * 1024 * 1024,
            }),
          catch: invalid,
        });
        const files = yield* Effect.try({ try: () => readTar(expanded), catch: invalid });
        if (
          !runtime.nativeFiles.every((name) =>
            files.some((file) => file.path === name && file.bytes.length > 0),
          )
        )
          return yield* new DictationError({
            reason: "install-failed",
            message: `The ${noun} runtime addon was missing.`,
          });
        for (const file of files) {
          const target = path.join(temporary, file.path);
          yield* io(fs.makeDirectory(path.dirname(target), { recursive: true }));
          yield* io(fs.writeFile(target, file.bytes));
        }
        yield* io(fs.remove(archive));
      }),
    );
    yield* progress(yield* inspectRuntime);
  });

  /** Downloads pinned files into `destination` atomically. Names may contain subdirectories. */
  const installFiles = Effect.fnUntraced(function* (
    noun: Noun,
    destination: string,
    files: readonly { name: string; url: string; bytes: number; sha256: string }[],
    progress: ProgressReport,
  ) {
    const current = yield* inspectFiles(destination, files);
    if (current._tag === "installed") return yield* progress(current);
    const report = throttled(progress);
    const totalBytes = files.reduce((total, file) => total + file.bytes, 0);
    yield* progress({ _tag: "installing", receivedBytes: 0, totalBytes });
    yield* atomicInstall(destination, (temporary) =>
      Effect.gen(function* () {
        let completed = 0;
        for (const file of files) {
          const target = path.join(temporary, file.name);
          yield* io(fs.makeDirectory(path.dirname(target), { recursive: true }));
          completed += yield* download(
            noun,
            file.url,
            target,
            "sha256",
            file.sha256,
            file.bytes,
            (received) =>
              report({ _tag: "installing", receivedBytes: completed + received, totalBytes }),
          );
        }
      }),
    );
    yield* progress({ _tag: "installed", sizeBytes: totalBytes });
  });

  const install: DictationArtifacts["Service"]["install"] = Effect.fnUntraced(
    function* (model, progress) {
      if (!runtime) return yield* unsupported("dictation");
      yield* installRuntime("dictation", (state) => progress("runtime", state));
      yield* installFiles("dictation", paths(model).model, models[model].files, (state) =>
        progress(model, state),
      );
    },
    Effect.scoped,
    mutations.withPermit,
  );
  const installSpeech: DictationArtifacts["Service"]["installSpeech"] = Effect.fnUntraced(
    function* (progress) {
      if (!runtime) return yield* unsupported("voice");
      yield* installRuntime("voice", (state) => progress("runtime", state));
      yield* installFiles("voice", speechPaths.model, speechModel.files, (state) =>
        progress("speech", state),
      );
    },
    Effect.scoped,
    mutations.withPermit,
  );
  const remove = Effect.fnUntraced(function* (model: DictationModelId) {
    const destination = paths(model).model;
    yield* io(fs.remove(destination, { recursive: true, force: true }));
    yield* io(fs.remove(`${destination}.tmp`, { recursive: true, force: true }));
  });
  const removeSpeech = Effect.gen(function* () {
    yield* io(fs.remove(speechPaths.model, { recursive: true, force: true }));
    yield* io(fs.remove(`${speechPaths.model}.tmp`, { recursive: true, force: true }));
  }).pipe(mutations.withPermit);
  return DictationArtifacts.of({
    supported: runtime !== null,
    paths,
    inspect,
    install,
    remove,
    speechPaths,
    inspectSpeech,
    installSpeech,
    removeSpeech,
  });
});

export const layer = Layer.effect(DictationArtifacts, make);
