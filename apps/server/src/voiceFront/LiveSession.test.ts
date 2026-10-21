import { assert, describe, it } from "@effect/vitest";

import { liveUsageCostUsd, spendMonth } from "./geminiCost.ts";
import {
  parseServerMessage,
  setupMessage,
  TOOL_CHECK_THREADS,
  TOOL_HAND_OFF,
} from "./geminiProtocol.ts";
import {
  LiveSession,
  type LiveSessionOptions,
  type LiveSocketHandlers,
  type TurnEvent,
} from "./LiveSession.ts";
import { createSpeechGate } from "./speechGate.ts";

/** 100 ms of 16 kHz audio. */
const chunk = () => new Float32Array(1_600).fill(0.1);

/** A Gemini Live server the test drives by hand. */
function fakeGemini() {
  const sockets: Array<{
    handlers: LiveSocketHandlers;
    sent: Array<Record<string, unknown>>;
    closed: boolean;
  }> = [];
  return {
    sockets,
    open: (handlers: LiveSocketHandlers) => {
      const socket = { handlers, sent: [] as Array<Record<string, unknown>>, closed: false };
      sockets.push(socket);
      return {
        send: (text: string) => void socket.sent.push(JSON.parse(text)),
        close: () => {
          socket.closed = true;
        },
      };
    },
    get last() {
      return sockets.at(-1)!;
    },
    /** Opens the latest socket and completes its setup. */
    accept() {
      const socket = sockets.at(-1)!;
      socket.handlers.onOpen();
      socket.handlers.onMessage(JSON.stringify({ setupComplete: {} }));
    },
    say(message: unknown) {
      sockets.at(-1)!.handlers.onMessage(JSON.stringify(message));
    },
  };
}

const kinds = (sent: ReadonlyArray<Record<string, unknown>>) =>
  sent.map((message) => {
    if ("setup" in message) return "setup";
    if ("toolResponse" in message) return "toolResponse";
    const input = message.realtimeInput as Record<string, unknown>;
    return Object.keys(input)[0]!;
  });

function harness(overrides: Partial<LiveSessionOptions> = {}) {
  const gemini = fakeGemini();
  const usage: unknown[] = [];
  const fatal: string[] = [];
  let nowMs = 1_000;
  const session = new LiveSession({
    model: "gemini-3.1-flash-live-preview",
    open: gemini.open,
    setup: (resumeHandle) =>
      setupMessage({
        model: "gemini-3.1-flash-live-preview",
        instructions: "Be brief.",
        worker: "Shift",
        resumeHandle,
      }),
    now: () => nowMs,
    onUsage: (report) => void usage.push(report),
    runTool: async (name) => `ran ${name}`,
    handOffResult: "Sent.",
    onFatal: (message) => void fatal.push(message),
    onTurnFailed: () => undefined,
    onTurnDone: () => undefined,
    ...overrides,
  });
  return {
    gemini,
    session,
    usage,
    fatal,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

const collect = (turn: { subscribe: (listener: (event: TurnEvent) => void) => unknown }) => {
  const events: TurnEvent[] = [];
  turn.subscribe((event) => events.push(event));
  return events;
};

describe("the speech gate", () => {
  it("sends nothing while the user is quiet, then a pre-roll with the first speech", () => {
    const gate = createSpeechGate({ preRollMs: 200, hangoverMs: 100 });
    for (let index = 0; index < 10; index++) assert.isNull(gate.push(chunk(), false));
    const start = gate.push(chunk(), true)!;
    assert.isTrue(start.start);
    // 200 ms of pre-roll plus the speech chunk itself.
    assert.strictEqual(start.audio.length, 3);
    assert.deepStrictEqual(gate.push(chunk(), false)?.audio.length, 1);
    // Past the hangover, silence is held back again...
    assert.isNull(gate.push(chunk(), false));
    assert.isNull(gate.push(chunk(), false));
    // ...and sent ahead of the next speech, without opening a second activity.
    const resumed = gate.push(chunk(), true)!;
    assert.isFalse(resumed.start);
    assert.strictEqual(resumed.audio.length, 3);
  });
});

describe("metering", () => {
  it("prices each modality and counts unplaced tokens at the dearest rate", () => {
    const usd = liveUsageCostUsd("gemini-3.1-flash-live-preview", {
      promptTokenCount: 1_100_000,
      promptTokensDetails: [
        { modality: "TEXT", tokenCount: 100_000 },
        { modality: "AUDIO", tokenCount: 900_000 },
      ],
      responseTokenCount: 1_000_000,
      responseTokensDetails: [{ modality: "AUDIO", tokenCount: 1_000_000 }],
      thoughtsTokenCount: 100_000,
    });
    // 0.075 text + 2.70 audio + 0.30 unplaced at the audio rate + 12.00 audio out + 0.45 thinking.
    assert.closeTo(usd, 15.525, 1e-9);
  });

  it("counts spend by UTC calendar month", () => {
    assert.strictEqual(spendMonth(Date.UTC(2026, 9, 31, 23, 59)), "2026-10");
    assert.strictEqual(spendMonth(Date.UTC(2026, 10, 1)), "2026-11");
  });
});

describe("the Gemini setup", () => {
  it("turns off Gemini's own detector and transcription, and keeps a small sliding window", () => {
    const { setup } = setupMessage({
      model: "gemini-3.8-live",
      instructions: "x",
      worker: "Shift",
      resumeHandle: "h1",
    });
    assert.deepStrictEqual(setup.realtimeInputConfig, {
      automaticActivityDetection: { disabled: true },
    });
    assert.notProperty(setup, "inputAudioTranscription");
    assert.notProperty(setup, "outputAudioTranscription");
    assert.isAtMost(setup.contextWindowCompression.triggerTokens, 4_000);
    assert.deepStrictEqual(setup.sessionResumption, { handle: "h1" });
    const declarations = setup.tools[0]!.functionDeclarations;
    assert.deepStrictEqual(
      declarations.map((declaration) => [declaration.name, declaration.behavior]),
      [
        [TOOL_HAND_OFF, "NON_BLOCKING"],
        [TOOL_CHECK_THREADS, "BLOCKING"],
      ],
    );
  });

  it("leaves non-blocking calls out for 3.1 Flash Live, which only calls tools in sequence", () => {
    const { setup } = setupMessage({
      model: "gemini-3.1-flash-live-preview",
      instructions: "x",
      worker: "Shift",
      resumeHandle: null,
    });
    for (const declaration of setup.tools[0]!.functionDeclarations)
      assert.notProperty(declaration, "behavior");
  });

  it("reads audio, tool calls, resumption, and usage from server messages", () => {
    const message = parseServerMessage(
      JSON.stringify({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "QUJD" } }],
          },
          turnComplete: true,
        },
        toolCall: { functionCalls: [{ id: "c1", name: "hand_off", args: {} }] },
        sessionResumptionUpdate: { newHandle: "h2", resumable: true },
        usageMetadata: { promptTokenCount: 5 },
      }),
    );
    assert.deepStrictEqual(message.audio, ["QUJD"]);
    assert.isTrue(message.turnComplete);
    assert.deepStrictEqual(message.toolCalls, [{ id: "c1", name: "hand_off" }]);
    assert.strictEqual(message.resumeHandle, "h2");
    assert.deepStrictEqual(message.usage, { promptTokenCount: 5 });
    assert.isNull(parseServerMessage("not json").resumeHandle);
  });
});

describe("a live session", () => {
  it("connects while the user is quiet but sends no audio until speech", () => {
    const { gemini, session } = harness();
    for (let index = 0; index < 20; index++) session.audio("d1", chunk(), false);
    gemini.accept();
    assert.deepStrictEqual(kinds(gemini.last.sent), ["setup"]);
    session.audio("d1", chunk(), true);
    session.audio("d1", chunk(), true);
    session.endOfTurn("d1");
    assert.deepStrictEqual(kinds(gemini.last.sent), [
      "setup",
      "activityStart",
      // 300 ms of pre-roll, then both speech chunks.
      "audio",
      "audio",
      "audio",
      "audio",
      "audio",
      "activityEnd",
    ]);
  });

  it("holds audio until setup completes, then sends it in order", () => {
    const { gemini, session } = harness();
    session.audio("d1", chunk(), true);
    session.endOfTurn("d1");
    assert.deepStrictEqual(kinds(gemini.last.sent), []);
    gemini.accept();
    assert.deepStrictEqual(kinds(gemini.last.sent), [
      "setup",
      "activityStart",
      "audio",
      "activityEnd",
    ]);
  });

  it("delivers the answer to the claimed turn, marks a hand-off, and answers the tool", async () => {
    const { gemini, session, usage } = harness();
    session.audio("d0", chunk(), false);
    gemini.accept();
    session.audio("d1", chunk(), true);
    session.endOfTurn("d1");
    gemini.say({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "AAAA" } }] },
      },
    });
    gemini.say({ toolCall: { functionCalls: [{ id: "c1", name: TOOL_HAND_OFF }] } });
    const turn = session.claim()!;
    const events = collect(turn);
    gemini.say({ serverContent: { turnComplete: true }, usageMetadata: { promptTokenCount: 40 } });
    assert.deepStrictEqual(events, [
      { type: "audio", data: "AAAA" },
      { type: "handoff" },
      { type: "done" },
    ]);
    assert.deepStrictEqual(usage, [{ promptTokenCount: 40 }]);
    const response = gemini.last.sent.find((message) => "toolResponse" in message)!;
    assert.deepStrictEqual(response.toolResponse, {
      functionResponses: [{ id: "c1", name: TOOL_HAND_OFF, response: { result: "Sent." } }],
    });
    // A turn is claimed once.
    assert.isNull(session.claim());
  });

  it("runs check_threads and returns its text", async () => {
    const { gemini, session } = harness({ runTool: async () => "PayParty: working" });
    session.audio("d0", chunk(), false);
    gemini.accept();
    session.audio("d1", chunk(), true);
    session.endOfTurn("d1");
    gemini.say({ toolCall: { functionCalls: [{ id: "c2", name: TOOL_CHECK_THREADS }] } });
    // The tool runs, then its response is sent, a few microtasks later.
    for (let tick = 0; tick < 5; tick++) await Promise.resolve();
    const response = gemini.last.sent.find((message) => "toolResponse" in message)!;
    assert.deepStrictEqual(response.toolResponse, {
      functionResponses: [
        { id: "c2", name: TOOL_CHECK_THREADS, response: { result: "PayParty: working" } },
      ],
    });
  });

  it("interrupts the answer that is playing when the user starts the next turn", () => {
    const { gemini, session } = harness();
    session.audio("d0", chunk(), false);
    gemini.accept();
    session.audio("d1", chunk(), true);
    session.endOfTurn("d1");
    const first = collect(session.claim()!);
    gemini.say({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm", data: "AAAA" } }] },
      },
    });
    // Barge-in: the next dictation hears speech over the reply.
    session.audio("d2", chunk(), true);
    gemini.say({ serverContent: { interrupted: true } });
    // Late audio from the cut-off answer is not played.
    gemini.say({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm", data: "LATE" } }] },
      },
    });
    assert.deepStrictEqual(first, [{ type: "audio", data: "AAAA" }, { type: "interrupted" }]);
    session.endOfTurn("d2");
    const second = collect(session.claim()!);
    gemini.say({ serverContent: { interrupted: true } });
    assert.deepStrictEqual(second, [{ type: "interrupted" }]);
  });

  it("reconnects after GoAway at the next quiet moment, resuming with the latest handle", () => {
    const { gemini, session } = harness();
    session.audio("d0", chunk(), false);
    gemini.accept();
    gemini.say({ sessionResumptionUpdate: { newHandle: "h1", resumable: true } });
    session.audio("d1", chunk(), true);
    session.endOfTurn("d1");
    gemini.say({ goAway: { timeLeft: "10s" } });
    // Mid-answer the connection stays.
    assert.isFalse(gemini.last.closed);
    gemini.say({ serverContent: { turnComplete: true } });
    assert.isTrue(gemini.last.closed);
    assert.strictEqual(gemini.sockets.length, 1);
    session.audio("d2", chunk(), true);
    assert.strictEqual(gemini.sockets.length, 2);
    gemini.last.handlers.onOpen();
    assert.deepStrictEqual(
      (gemini.last.sent[0] as { setup: { sessionResumption: unknown } }).setup.sessionResumption,
      { handle: "h1" },
    );
  });

  it("fails the turn when Gemini drops mid-answer, and reports a refused setup as fatal", () => {
    const failed: string[] = [];
    const { gemini, session, fatal } = harness({
      onTurnFailed: (message) => void failed.push(message),
    });
    session.audio("d0", chunk(), false);
    gemini.accept();
    session.audio("d1", chunk(), true);
    session.endOfTurn("d1");
    const events = collect(session.claim()!);
    gemini.last.handlers.onClose({ code: 1011, reason: "internal" });
    assert.deepStrictEqual(events, [{ type: "failed", message: "Gemini disconnected: internal" }]);
    assert.strictEqual(failed.length, 1);
    assert.isFalse(session.closed);

    const refused = harness();
    refused.session.audio("d1", chunk(), true);
    refused.gemini.last.handlers.onClose({ code: 1008, reason: "API key not valid" });
    assert.deepStrictEqual(refused.fatal, ["API key not valid"]);
    assert.isTrue(refused.session.closed);
    assert.deepStrictEqual(fatal, []);
  });

  it("does not hand an old unread turn to a new reply", () => {
    const { gemini, session, advance } = harness();
    session.audio("d0", chunk(), false);
    gemini.accept();
    session.audio("d1", chunk(), true);
    session.endOfTurn("d1");
    advance(60_000);
    assert.isNull(session.claim());
  });

  it("closes after the current answer once retired", () => {
    const { gemini, session } = harness();
    session.audio("d0", chunk(), false);
    gemini.accept();
    session.audio("d1", chunk(), true);
    session.endOfTurn("d1");
    session.retire();
    assert.isFalse(session.closed);
    session.audio("d2", chunk(), true);
    assert.notInclude(kinds(gemini.last.sent).slice(-1), "activityStart");
    gemini.say({ serverContent: { turnComplete: true } });
    assert.isTrue(session.closed);
    assert.isTrue(gemini.last.closed);
  });
});
