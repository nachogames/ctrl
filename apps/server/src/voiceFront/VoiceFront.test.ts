import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, it } from "@effect/vitest";
import { ThreadId, VOICE_FRONT_MAX_MODEL_BYTES, VoiceFrontError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { chatMessages, contextText, parseFrontOutput, threadState } from "./frontPrompt.ts";
import { checkModel, sseDelta } from "./LmStudio.ts";
import * as GeminiLive from "./GeminiLive.ts";
import { LiveTurn } from "./LiveSession.ts";
import * as VoiceFront from "./VoiceFront.ts";
import * as VoiceFrontContext from "./VoiceFrontContext.ts";

/** What `lms ls --json` reported on the developer's Mac, trimmed to the fields read. */
const MODELS = [
  {
    modelKey: "qwen3-4b-instruct-2507-mlx",
    sizeBytes: 2_278_973_995,
    path: "lmstudio-community/Qwen3-4B-Instruct-2507-MLX-4bit",
  },
  { modelKey: "zai-org/glm-4.7-flash", sizeBytes: 31_841_422_273, path: "zai-org/glm-4.7-flash" },
];

describe("the model size guard", () => {
  it("refuses the 30 GB GLM model and accepts the small default", () => {
    const refused = checkModel(MODELS, "zai-org/glm-4.7-flash", VOICE_FRONT_MAX_MODEL_BYTES);
    assert.instanceOf(refused, VoiceFrontError);
    assert.strictEqual((refused as VoiceFrontError).reason, "model-too-large");
    assert.match((refused as VoiceFrontError).message, /29\.7 GB, over the 6\.0 GB limit/);
    assert.deepStrictEqual(
      checkModel(MODELS, "qwen3-4b-instruct-2507-mlx", VOICE_FRONT_MAX_MODEL_BYTES),
      { sizeBytes: 2_278_973_995 },
    );
  });

  it("refuses a model LM Studio does not list or cannot size", () => {
    const missing = checkModel(MODELS, "qwen3-8b", VOICE_FRONT_MAX_MODEL_BYTES);
    assert.strictEqual((missing as VoiceFrontError).reason, "model-missing");
    const unsized = checkModel([{ modelKey: "x", sizeBytes: 0 }], "x", VOICE_FRONT_MAX_MODEL_BYTES);
    assert.strictEqual((unsized as VoiceFrontError).reason, "model-too-large");
  });
});

describe("the front's output", () => {
  it("holds back a tag until it is complete, and never speaks it", () => {
    assert.deepStrictEqual(parseFrontOutput("[ans"), { text: "", answered: false });
    assert.deepStrictEqual(parseFrontOutput("[answered] Hey"), { text: "Hey", answered: true });
    assert.deepStrictEqual(parseFrontOutput("[answered]: Hi"), { text: "Hi", answered: true });
    assert.deepStrictEqual(parseFrontOutput(" [handoff] On it, asking Shift."), {
      text: "On it, asking Shift.",
      answered: false,
    });
  });

  it("treats a missing tag as a handoff and drops markdown", () => {
    assert.deepStrictEqual(parseFrontOutput("**Sure**, the `build` passed."), {
      text: "Sure, the build passed.",
      answered: false,
    });
  });

  it("reads deltas from a streaming chat response", () => {
    assert.strictEqual(sseDelta('data: {"choices":[{"delta":{"content":"Hi"}}]}'), "Hi");
    assert.strictEqual(sseDelta("data: [DONE]"), "done");
    assert.strictEqual(sseDelta(": keep-alive"), null);
  });
});

describe("the front's context", () => {
  it("describes Shift's threads from the snapshot and only from it", () => {
    const text = contextText({
      kind: "shift",
      title: "Shift",
      threads: [
        { title: "PayParty build", state: "working", ago: "2 min ago", last: null },
        { title: "Docs", state: "done", ago: "1 h ago", last: "Merged the docs PR." },
      ],
      messages: [{ role: "user", text: "Start the build" }],
    });
    assert.include(text, `- "PayParty build": working, updated 2 min ago`);
    assert.include(text, `Last reply: "Merged the docs PR."`);
    assert.include(text, "User: Start the build");
    const [system, user] = chatMessages(
      { kind: "thread", title: "Fix login", threads: [], messages: [] },
      "how's it going",
    );
    assert.include(system!.content, "Never invent");
    assert.include(system!.content, `This is the thread "Fix login"`);
    assert.deepStrictEqual(user, { role: "user", content: "how's it going" });
  });

  it("names what needs the user", () => {
    const shell = {
      pendingRuntimeRequest: { kind: "approval" },
      hasActionableProposedPlan: false,
      activityRunStatus: null,
      status: "running",
    } as unknown as Parameters<typeof threadState>[0];
    assert.strictEqual(threadState(shell), "needs you: waiting for an approval");
  });
});

const output = (stdout: string): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const sse = (...deltas: ReadonlyArray<string>) =>
  [
    ...deltas.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`),
    "data: [DONE]",
    "",
  ].join("\n\n");

interface Harness {
  readonly lmsCalls: string[][];
  readonly chatBodies: unknown[];
  /** The server answers once `lms server start` has run, or from the start. */
  serverUp: boolean;
}

const noGemini: GeminiLive.GeminiLive["Service"] = {
  status: Effect.succeed({
    keySet: false,
    monthSpendUsd: 0,
    monthlyCapUsd: 10,
    capped: false,
    problem: null,
  }),
  setKey: () => Effect.void,
  claim: () => Effect.succeed({ _tag: "fallback", notice: null }),
  notice: () => Effect.succeed(null),
  end: () => Effect.void,
};

const testLayer = (
  harness: Harness,
  model: string,
  options: {
    readonly gemini?: GeminiLive.GeminiLive["Service"];
    readonly engine?: "local" | "gemini";
  } = {},
) =>
  VoiceFront.layer.pipe(
    Layer.provide(Layer.succeed(GeminiLive.GeminiLive, options.gemini ?? noGemini)),
    Layer.provide(
      Layer.succeed(VoiceFrontContext.VoiceFrontContext, {
        load: () =>
          Effect.succeed({ kind: "shift" as const, title: "Shift", threads: [], messages: [] }),
      }),
    ),
    Layer.provide(
      Layer.succeed(ProcessRunner.ProcessRunner, {
        run: (input) =>
          Effect.sync(() => {
            harness.lmsCalls.push([...input.args]);
            if (input.args[0] === "server") harness.serverUp = true;
            assert.notProperty(
              Object.fromEntries(
                Object.entries(input.env ?? {}).filter(([, value]) => value !== undefined),
              ),
              "ELECTRON_RUN_AS_NODE",
            );
            return output(input.args[0] === "ls" ? JSON.stringify(MODELS) : "");
          }),
      }),
    ),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.gen(function* () {
            if (!harness.serverUp)
              return yield* new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request,
                  description: "ECONNREFUSED",
                }),
              });
            if (request.method === "GET")
              return HttpClientResponse.fromWeb(request, new Response('{"data":[]}'));
            const body = request.body;
            harness.chatBodies.push(
              body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(body.body)) : null,
            );
            return HttpClientResponse.fromWeb(
              request,
              new Response(sse("[answ", "ered] Hey", "! Two threads", " are running.")),
            );
          }),
        ),
      ),
    ),
    Layer.provide(FileSystem.layerNoop({ exists: () => Effect.succeed(true) })),
    Layer.provide(NodePath.layer),
    Layer.provide(
      ServerSettings.layerTest({
        voiceFront: { enabled: true, model, engine: options.engine ?? "local" },
      }),
    ),
  );

const respond = Effect.gen(function* () {
  const front = yield* VoiceFront.VoiceFront;
  return yield* front
    .respond({ threadId: ThreadId.make("home:shift"), transcript: "what's up", turnId: "t1" })
    .pipe(Stream.runCollect);
});

describe("VoiceFront", () => {
  it.effect(
    "starts LM Studio's server, asks only for the configured model with a TTL, and streams",
    () => {
      const harness: Harness = { lmsCalls: [], chatBodies: [], serverUp: false };
      return Effect.gen(function* () {
        const replies = Array.from(yield* respond);
        assert.deepStrictEqual(harness.lmsCalls, [
          ["server", "start"],
          ["ls", "--json"],
        ]);
        assert.strictEqual(harness.chatBodies.length, 1);
        const body = harness.chatBodies[0] as Record<string, unknown>;
        assert.strictEqual(body.model, "qwen3-4b-instruct-2507-mlx");
        assert.strictEqual(body.ttl, VoiceFront.VOICE_FRONT_IDLE_TTL_SECONDS);
        assert.strictEqual(body.stream, true);
        // The tag is never spoken, and each update carries the whole reply so far.
        assert.deepStrictEqual(
          replies.map((reply) => reply.text),
          [
            "Hey",
            "Hey! Two threads",
            "Hey! Two threads are running.",
            "Hey! Two threads are running.",
          ],
        );
        const last = replies.at(-1)!;
        assert.isTrue(last.done);
        assert.isTrue(last.answered);
        assert.isNotNull(last.firstTokenMs);
      }).pipe(Effect.provide(testLayer(harness, "qwen3-4b-instruct-2507-mlx")));
    },
  );

  it.effect("refuses a large model before any chat request reaches LM Studio", () => {
    const harness: Harness = { lmsCalls: [], chatBodies: [], serverUp: true };
    return Effect.gen(function* () {
      const error = yield* respond.pipe(Effect.flip);
      assert.strictEqual(error.reason, "model-too-large");
      assert.strictEqual(harness.chatBodies.length, 0);
      assert.deepStrictEqual(harness.lmsCalls, [["ls", "--json"]]);
      const status = yield* (yield* VoiceFront.VoiceFront).status;
      assert.match(status.problem ?? "", /over the 6\.0 GB limit/);
    }).pipe(Effect.provide(testLayer(harness, "zai-org/glm-4.7-flash")));
  });

  it.effect("speaks Gemini's audio and reads the agent's reply after a hand-off", () => {
    const harness: Harness = { lmsCalls: [], chatBodies: [], serverUp: true };
    const turn = new LiveTurn(0);
    turn.emit({ type: "audio", data: "AAAA" });
    turn.emit({ type: "handoff" });
    turn.emit({ type: "audio", data: "BBBB" });
    turn.emit({ type: "done" });
    return Effect.gen(function* () {
      const replies = Array.from(yield* respond);
      assert.deepStrictEqual(
        replies.flatMap((reply) => reply.audio ?? []),
        ["AAAA", "BBBB"],
      );
      const last = replies.at(-1)!;
      assert.isTrue(last.done);
      // Gemini handed off, so the agent's reply is read.
      assert.isFalse(last.answered);
      assert.strictEqual(harness.chatBodies.length, 0);
    }).pipe(
      Effect.provide(
        testLayer(harness, "qwen3-4b-instruct-2507-mlx", {
          engine: "gemini",
          gemini: { ...noGemini, claim: () => Effect.succeed({ _tag: "turn", turn }) },
        }),
      ),
    );
  });

  it.effect("ends at once when the user talks over Gemini", () => {
    const harness: Harness = { lmsCalls: [], chatBodies: [], serverUp: true };
    const turn = new LiveTurn(0);
    turn.emit({ type: "audio", data: "AAAA" });
    turn.emit({ type: "interrupted" });
    return Effect.gen(function* () {
      const last = Array.from(yield* respond).at(-1)!;
      assert.isTrue(last.done);
      assert.isTrue(last.interrupted);
    }).pipe(
      Effect.provide(
        testLayer(harness, "qwen3-4b-instruct-2507-mlx", {
          engine: "gemini",
          gemini: { ...noGemini, claim: () => Effect.succeed({ _tag: "turn", turn }) },
        }),
      ),
    );
  });

  it.effect("falls back to the local front, saying why once, when Gemini cannot answer", () => {
    const harness: Harness = { lmsCalls: [], chatBodies: [], serverUp: true };
    const turn = new LiveTurn(0);
    turn.emit({ type: "failed", message: "Gemini disconnected" });
    return Effect.gen(function* () {
      const last = Array.from(yield* respond).at(-1)!;
      assert.strictEqual(last.text, "Gemini is out. Hey! Two threads are running.");
      assert.isTrue(last.answered);
      assert.strictEqual(harness.chatBodies.length, 1);
    }).pipe(
      Effect.provide(
        testLayer(harness, "qwen3-4b-instruct-2507-mlx", {
          engine: "gemini",
          gemini: {
            ...noGemini,
            claim: () => Effect.succeed({ _tag: "turn", turn }),
            notice: () => Effect.succeed("Gemini is out."),
          },
        }),
      ),
    );
  });

  it.effect("still says the notice when the local front cannot answer either", () => {
    const harness: Harness = { lmsCalls: [], chatBodies: [], serverUp: true };
    return Effect.gen(function* () {
      const replies = Array.from(yield* respond);
      assert.deepStrictEqual(replies, [
        { text: "Over the cap.", done: true, answered: false, firstTokenMs: null },
      ]);
    }).pipe(
      Effect.provide(
        testLayer(harness, "zai-org/glm-4.7-flash", {
          engine: "gemini",
          gemini: {
            ...noGemini,
            claim: () => Effect.succeed({ _tag: "fallback", notice: "Over the cap." }),
          },
        }),
      ),
    );
  });
});
