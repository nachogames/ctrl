import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as AppleSpeech from "./AppleSpeech.ts";

interface FakeHelper {
  readonly args: ReadonlyArray<string>;
  readonly frames: Array<{ kind: string; payload: Uint8Array }>;
}

/** Splits the bytes the server wrote into helper frames. */
function parseFrames(bytes: Uint8Array) {
  const frames: Array<{ kind: string; payload: Uint8Array }> = [];
  let offset = 0;
  while (offset + 5 <= bytes.length) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 4).getUint32(0, true);
    frames.push({
      kind: String.fromCharCode(bytes[offset]!),
      payload: bytes.slice(offset + 5, offset + 5 + length),
    });
    offset += 5 + length;
  }
  return frames;
}

/**
 * A fake helper process. `respond` sees each frame as it arrives and returns
 * the stdout lines to emit; `initial` lines are emitted at spawn.
 */
const fakeSpawner = (
  helpers: FakeHelper[],
  options: {
    readonly initial: ReadonlyArray<object>;
    readonly respond?: (frame: { kind: string; payload: Uint8Array }) => ReadonlyArray<object>;
    /** Exit after the initial lines, as a command like probe does. */
    readonly exitAfterInitial?: boolean;
  },
) =>
  ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const helper: FakeHelper = {
        args: (command as unknown as { args: ReadonlyArray<string> }).args,
        frames: [],
      };
      helpers.push(helper);
      const stdout = yield* Queue.unbounded<Uint8Array, import("effect/Cause").Done>();
      const emit = (lines: ReadonlyArray<object>) =>
        Effect.forEach(lines, (line) =>
          Queue.offer(stdout, new TextEncoder().encode(`${JSON.stringify(line)}\n`)),
        );
      yield* emit(options.initial);
      if (options.exitAfterInitial) yield* Queue.end(stdout);
      let buffered = new Uint8Array();
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(true),
        kill: () => Queue.end(stdout).pipe(Effect.asVoid),
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.gen(function* () {
            const next = new Uint8Array(buffered.length + chunk.length);
            next.set(buffered);
            next.set(chunk, buffered.length);
            const frames = parseFrames(next);
            const consumed = frames.reduce((n, frame) => n + 5 + frame.payload.length, 0);
            buffered = next.slice(consumed);
            for (const frame of frames) {
              helper.frames.push(frame);
              yield* emit(options.respond?.(frame) ?? []);
            }
          }),
        ),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );

const service = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  AppleSpeech.makeWithBinary(Effect.succeed("/fake/ctrl-apple-speech")).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
  );

it("frames payloads with a kind byte and little-endian length", () => {
  const frame = AppleSpeech.encodeFrame("A", new Uint8Array([1, 2, 3]));
  assert.deepStrictEqual([...frame], [65, 3, 0, 0, 0, 1, 2, 3]);
  assert.deepStrictEqual([...AppleSpeech.encodeFrame("E")], [69, 0, 0, 0, 0]);
});

it("converts float samples to clamped int16 PCM", () => {
  const bytes = AppleSpeech.encodePcm16(new Float32Array([0, 1, -1, 2]));
  const view = new DataView(bytes.buffer);
  assert.deepStrictEqual(
    [0, 1, 2, 3].map((i) => view.getInt16(i * 2, true)),
    [0, 32767, -32767, 32767],
  );
});

it.effect("streams vocabulary and audio, then returns the finalized phrases", () =>
  Effect.gen(function* () {
    const helpers: FakeHelper[] = [];
    const apple = yield* service(
      fakeSpawner(helpers, {
        initial: [{ type: "ready", locale: "en-US" }],
        respond: (frame) =>
          frame.kind === "A"
            ? [{ type: "partial", text: "What is" }]
            : frame.kind === "E"
              ? [
                  { type: "final", text: "What is the PayParty thread" },
                  { type: "final", text: " doing right now? " },
                  { type: "done" },
                ]
              : [],
      }),
    );
    const session = yield* apple.open({ language: "auto", words: ["PayParty"] });
    yield* session.write(new Uint8Array(3200));
    const result = yield* session.finish;
    yield* session.close;
    assert.deepStrictEqual(result, {
      text: "What is the PayParty thread doing right now?",
      locale: "en-US",
    });
    const [helper] = helpers;
    assert.deepStrictEqual(helper?.args, ["transcribe", "--locale", "auto"]);
    assert.deepStrictEqual(
      helper?.frames.map((frame) => frame.kind),
      ["C", "A", "E"],
    );
    assert.deepStrictEqual(JSON.parse(new TextDecoder().decode(helper?.frames[0]?.payload)), {
      words: ["PayParty"],
    });
    assert.strictEqual(helper?.frames[1]?.payload.length, 3200);
  }),
);

it.effect("reports finalized phrases plus the phrase still being spoken as live text", () =>
  Effect.gen(function* () {
    let audio = 0;
    const apple = yield* service(
      fakeSpawner([], {
        initial: [{ type: "ready", locale: "en-US" }],
        respond: (frame) => {
          if (frame.kind === "E") return [{ type: "done" }];
          if (frame.kind !== "A") return [];
          audio += 1;
          return audio === 1
            ? [{ type: "partial", text: "Hello" }]
            : [
                { type: "final", text: "Hello there." },
                { type: "partial", text: "How are" },
              ];
        },
      }),
    );
    const session = yield* apple.open({ language: "en-US", words: [] });
    assert.strictEqual(yield* session.partial, "");
    yield* session.write(new Uint8Array(3200));
    yield* session.write(new Uint8Array(3200));
    // Finishing waits for "done", so every earlier event has been read.
    yield* session.finish;
    assert.strictEqual(yield* session.partial, "Hello there. How are");
    yield* session.close;
  }),
);

it.effect("surfaces a helper error event as a dictation error", () =>
  Effect.gen(function* () {
    const apple = yield* service(
      fakeSpawner([], {
        initial: [{ type: "error", code: "unavailable", message: "Needs macOS 26." }],
      }),
    );
    const session = yield* apple.open({ language: "auto", words: [] });
    const error = yield* session.finish.pipe(Effect.flip);
    assert.strictEqual(error.reason, "unsupported-platform");
    assert.strictEqual(error.message, "Needs macOS 26.");
  }),
);

it.effect("fails finish when the helper exits without finishing", () =>
  Effect.gen(function* () {
    const apple = yield* service(
      fakeSpawner([], { initial: [{ type: "ready", locale: "en-US" }], exitAfterInitial: true }),
    );
    const session = yield* apple.open({ language: "auto", words: [] });
    const error = yield* session.finish.pipe(Effect.flip);
    assert.strictEqual(error.message, "Apple speech recognition stopped unexpectedly.");
  }),
);

it.effect("probes availability, and reads a broken helper as unavailable", () =>
  Effect.gen(function* () {
    const helpers: FakeHelper[] = [];
    const apple = yield* service(
      fakeSpawner(helpers, {
        initial: [
          {
            type: "probe",
            available: true,
            locale: "fr-FR",
            assets: "supported",
            locales: [{ code: "fr-FR", label: "French (France)" }],
          },
        ],
        exitAfterInitial: true,
      }),
    );
    const probe = yield* apple.probe("fr");
    assert.deepStrictEqual(helpers[0]?.args, ["probe", "--locale", "fr"]);
    assert.deepStrictEqual(probe, {
      available: true,
      reason: null,
      locale: "fr-FR",
      assets: "supported",
      languageOptions: [{ code: "fr-FR", label: "French (France)" }],
    });

    const broken = yield* service(
      fakeSpawner([], { initial: [{ type: "nonsense" }], exitAfterInitial: true }),
    );
    const unavailable = yield* broken.probe("auto");
    assert.strictEqual(unavailable.available, false);
    assert.strictEqual(unavailable.reason, "Apple speech recognition sent an invalid event.");
  }),
);

it.effect("reports asset download progress while installing", () =>
  Effect.gen(function* () {
    const seen: Array<[number, number]> = [];
    const apple = yield* service(
      fakeSpawner([], {
        initial: [
          { type: "progress", completed: 1, total: 4 },
          { type: "progress", completed: 4, total: 4 },
          { type: "installed", locale: "en-US" },
        ],
        exitAfterInitial: true,
      }),
    );
    yield* apple.install("auto", (completed, total) =>
      Effect.sync(() => {
        seen.push([completed, total]);
      }),
    );
    assert.deepStrictEqual(seen, [
      [1, 4],
      [4, 4],
    ]);
  }),
);
