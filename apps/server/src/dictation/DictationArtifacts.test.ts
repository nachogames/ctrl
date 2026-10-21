import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ServerConfig from "../config.ts";
import * as DictationArtifacts from "./DictationArtifacts.ts";
import { runtimeFor, speechModel, turnModel, vadModel } from "./models.ts";

const layer = (http: HttpClient.HttpClient) =>
  DictationArtifacts.layer.pipe(
    // A supported host, so runtime paths and native file names are the same on every machine.
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HostProcess.Platform, "darwin"),
        Layer.succeed(HostProcess.Architecture, "arm64"),
      ),
    ),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-dictation-artifacts-" })),
    Layer.provideMerge(NodeServices.layer),
  );

it.effect("removing a model reclaims installed files and abandoned staging", () =>
  Effect.gen(function* () {
    const service = yield* DictationArtifacts.DictationArtifacts;
    const fs = yield* FileSystem.FileSystem;
    const destination = service.paths("whisper-turbo").model;
    for (const directory of [destination, `${destination}.tmp`]) {
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(`${directory}/partial`, "model bytes");
    }
    yield* service.remove("whisper-turbo");
    assert.strictEqual(yield* fs.exists(destination), false);
    assert.strictEqual(yield* fs.exists(`${destination}.tmp`), false);
  }).pipe(Effect.provide(layer(HttpClient.make(() => Effect.never))), Effect.scoped),
);

it.effect("recovers abandoned staging and cleans an integrity failure", () =>
  Effect.gen(function* () {
    const service = yield* DictationArtifacts.DictationArtifacts;
    const fs = yield* FileSystem.FileSystem;
    const staging = `${service.paths("parakeet-v3").runtime}.tmp`;
    yield* fs.makeDirectory(staging, { recursive: true });
    yield* fs.writeFileString(`${staging}/abandoned`, "partial download");
    const error = yield* service.install("parakeet-v3", () => Effect.void).pipe(Effect.flip);
    assert.strictEqual(error.reason, "install-failed");
    assert.strictEqual(error.message, "The dictation download failed integrity verification.");
    assert.strictEqual(yield* fs.exists(staging), false);
    assert.strictEqual((yield* service.inspect).runtime._tag, "not-installed");
  }).pipe(
    Effect.provide(
      layer(
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response("corrupt"))),
        ),
      ),
    ),
    Effect.scoped,
  ),
);

it.effect("cancels a pending download and removes its staging files", () =>
  Effect.gen(function* () {
    const requested = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const service = yield* DictationArtifacts.DictationArtifacts;
      const fs = yield* FileSystem.FileSystem;
      const staging = `${service.paths("parakeet-v3").runtime}.tmp`;
      const downloading = yield* service
        .install("parakeet-v3", () => Effect.void)
        .pipe(Effect.forkChild);
      yield* Deferred.await(requested);
      yield* Fiber.interrupt(downloading);
      assert.strictEqual(yield* fs.exists(staging), false);
    }).pipe(
      Effect.provide(
        layer(
          HttpClient.make(() =>
            Deferred.succeed(requested, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        ),
      ),
      Effect.scoped,
    );
  }),
);

it("pins every voice file the Kokoro config reads", () => {
  const names = speechModel.files.map((file) => file.name);
  assert.strictEqual(new Set(names).size, names.length);
  for (const file of speechModel.files) {
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
    assert.isAbove(file.bytes, 0);
    assert.match(
      file.url,
      /^https:\/\/huggingface\.co\/csukuangfj\/kokoro-int8-multi-lang-v1_0\/resolve\/[0-9a-f]{40}\//,
    );
    assert.isTrue(file.url.endsWith(`/${file.name}`));
  }
  const { kokoro } = speechModel.config((name) => name);
  for (const required of [kokoro.model, kokoro.voices, kokoro.tokens, kokoro.lexicon])
    assert.include(names, required);
  for (const espeak of ["phontab", "phonindex", "phondata", "intonations", "en_dict"])
    assert.include(names, `${kokoro.dataDir}/${espeak}`);
  const speakers = Object.values(speechModel.voices).map((voice) => voice.speaker);
  assert.strictEqual(new Set(speakers).size, speakers.length);
});

const installNativeFiles = Effect.gen(function* () {
  const service = yield* DictationArtifacts.DictationArtifacts;
  const fs = yield* FileSystem.FileSystem;
  for (const name of runtimeFor("darwin", "arm64")!.nativeFiles) {
    yield* fs.makeDirectory(service.speechPaths.runtime, { recursive: true });
    yield* fs.writeFileString(`${service.speechPaths.runtime}/${name}`, "native");
  }
});

const installRuntimeFiles = Effect.gen(function* () {
  const service = yield* DictationArtifacts.DictationArtifacts;
  const fs = yield* FileSystem.FileSystem;
  yield* installNativeFiles;
  const directory = service.vadPaths.model.slice(0, service.vadPaths.model.lastIndexOf("/"));
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* fs.writeFile(service.vadPaths.model, new Uint8Array(vadModel.file.bytes));
});

const requested: string[] = [];

it.effect("a runtime from before hands-free voice fetches only the VAD model", () =>
  Effect.gen(function* () {
    const service = yield* DictationArtifacts.DictationArtifacts;
    yield* installNativeFiles;
    assert.strictEqual((yield* service.inspectSpeech).runtime._tag, "not-installed");
    const error = yield* service.installSpeech(() => Effect.void).pipe(Effect.flip);
    assert.strictEqual(error.message, "The voice download failed integrity verification.");
    assert.deepStrictEqual(requested, [vadModel.file.url]);
  }).pipe(
    Effect.provide(
      layer(
        HttpClient.make((request) =>
          Effect.sync(() => {
            requested.push(request.url);
            return HttpClientResponse.fromWeb(request, new Response("corrupt"));
          }),
        ),
      ),
    ),
    Effect.scoped,
  ),
);

it.effect("a corrupt voice download reuses the runtime and leaves nothing behind", () =>
  Effect.gen(function* () {
    const service = yield* DictationArtifacts.DictationArtifacts;
    const fs = yield* FileSystem.FileSystem;
    yield* installRuntimeFiles;
    const reported: string[] = [];
    const error = yield* service
      .installSpeech((artifact, state) =>
        Effect.sync(() => {
          reported.push(`${artifact}:${state._tag}`);
        }),
      )
      .pipe(Effect.flip);
    assert.strictEqual(error.message, "The voice download failed integrity verification.");
    assert.deepStrictEqual(reported.slice(0, 2), ["runtime:installed", "speech:installing"]);
    assert.notInclude(reported, "speech:installed");
    assert.strictEqual(yield* fs.exists(`${service.speechPaths.model}.tmp`), false);
    const state = yield* service.inspectSpeech;
    assert.strictEqual(state.runtime._tag, "installed");
    assert.strictEqual(state.model._tag, "not-installed");
  }).pipe(
    Effect.provide(
      layer(
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response("corrupt"))),
        ),
      ),
    ),
    Effect.scoped,
  ),
);

it.effect("removing the voice keeps the shared runtime", () =>
  Effect.gen(function* () {
    const service = yield* DictationArtifacts.DictationArtifacts;
    const fs = yield* FileSystem.FileSystem;
    yield* installRuntimeFiles;
    yield* fs.makeDirectory(service.speechPaths.runtime, { recursive: true });
    for (const directory of [service.speechPaths.model, `${service.speechPaths.model}.tmp`]) {
      yield* fs.makeDirectory(`${directory}/espeak-ng-data`, { recursive: true });
      yield* fs.writeFileString(`${directory}/espeak-ng-data/phontab`, "voice bytes");
    }
    yield* service.removeSpeech;
    assert.strictEqual(yield* fs.exists(service.speechPaths.model), false);
    assert.strictEqual(yield* fs.exists(`${service.speechPaths.model}.tmp`), false);
    assert.strictEqual(yield* fs.exists(service.speechPaths.runtime), true);
  }).pipe(Effect.provide(layer(HttpClient.make(() => Effect.never))), Effect.scoped),
);

it("pins every Smart Turn file the classifier loads", () => {
  const names = turnModel.files.map((file) => file.name);
  assert.sameMembers(names, [turnModel.model, turnModel.ortModule, turnModel.wasm]);
  for (const file of turnModel.files) {
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
    assert.isAbove(file.bytes, 0);
    // Pinned to a revision or an exact version, never a moving tag.
    assert.match(
      file.url,
      /^https:\/\/(huggingface\.co\/pipecat-ai\/smart-turn-v3\/resolve\/[0-9a-f]{40}|cdn\.jsdelivr\.net\/npm\/onnxruntime-web@\d+\.\d+\.\d+\/dist)\//,
    );
    assert.isTrue(file.url.endsWith(`/${file.name}`));
  }
});

const turnRequests: string[] = [];

it.effect("a failed turn model download leaves the runtime installed", () =>
  Effect.gen(function* () {
    const service = yield* DictationArtifacts.DictationArtifacts;
    yield* installRuntimeFiles;
    turnRequests.length = 0;
    const reported: string[] = [];
    // The voice model itself still fails; the runtime step before it must not.
    yield* service
      .installSpeech((artifact, state) =>
        Effect.sync(() => {
          reported.push(`${artifact}:${state._tag}`);
        }),
      )
      .pipe(Effect.flip);
    assert.include(turnRequests, turnModel.files[0]!.url);
    assert.strictEqual(reported[0], "runtime:installed");
    assert.isFalse(yield* service.turnInstalled);
    assert.strictEqual((yield* service.inspectSpeech).runtime._tag, "installed");
  }).pipe(
    Effect.provide(
      layer(
        HttpClient.make((request) =>
          Effect.sync(() => {
            turnRequests.push(request.url);
            return HttpClientResponse.fromWeb(request, new Response("corrupt"));
          }),
        ),
      ),
    ),
    Effect.scoped,
  ),
);
