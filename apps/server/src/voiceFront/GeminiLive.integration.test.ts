import { assert, it } from "@effect/vitest";
import { DEFAULT_GEMINI_LIVE_MODEL, type GeminiLiveModel } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { liveUsageCostUsd, type LiveUsage } from "./geminiCost.ts";
import { liveUrl, setupMessage } from "./geminiProtocol.ts";
import { geminiInstructions } from "./frontPrompt.ts";
import * as GeminiLive from "./GeminiLive.ts";
import { LiveSession, type TurnEvent } from "./LiveSession.ts";

/**
 * A real Gemini Live round trip. Set `T3_GEMINI_API_KEY`, and
 * `T3_GEMINI_LIVE_FIXTURE` to a 16 kHz mono int16 WAV of a short spoken
 * question; `T3_GEMINI_LIVE_MODEL` picks the model. It bills a few tenths
 * of a cent. Run explicitly.
 */
const key = process.env.T3_GEMINI_API_KEY;
const fixture = process.env.T3_GEMINI_LIVE_FIXTURE;
const model = (process.env.T3_GEMINI_LIVE_MODEL ?? DEFAULT_GEMINI_LIVE_MODEL) as GeminiLiveModel;

const readWav = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset < bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    if (id === "data") {
      const samples = new Float32Array(size / 2);
      for (let index = 0; index < samples.length; index++)
        samples[index] = view.getInt16(offset + 8 + index * 2, true) / 32768;
      return samples;
    }
    offset += 8 + size;
  }
  throw new Error("The fixture has no data chunk.");
};

// oxlint-disable-next-line t3code/no-test-timeout-or-unreasoned-skip -- opt-in round trip to the real Gemini Live API, skipped without a key and fixture
it.skipIf(!key || !fixture)(
  "Gemini Live answers a spoken turn in audio and reports usage",
  () =>
    Effect.gen(function* () {
      const opener = yield* GeminiLive.LiveSocketOpener;
      const usage: LiveUsage[] = [];
      const session = new LiveSession({
        model,
        open: (handlers) => opener.open(liveUrl(key!), handlers),
        setup: (resumeHandle) =>
          setupMessage({
            model,
            instructions: geminiInstructions("shift"),
            worker: "Shift",
            resumeHandle,
          }),
        // oxlint-disable-next-line t3code/no-wall-clock-in-tests -- the live session times a real network socket; nothing asserts on elapsed time
        now: () => performance.now(),
        onUsage: (report) => void usage.push(report),
        runTool: async () => "There are no threads.",
        handOffResult: "Sent.",
        onFatal: (message) => {
          throw new Error(`Gemini refused the session: ${message}`);
        },
        onTurnFailed: () => undefined,
        onTurnDone: () => undefined,
      });
      const samples = readWav(yield* (yield* FileSystem.FileSystem).readFile(fixture!));
      for (let start = 0; start < samples.length; start += 1_600)
        session.audio("fixture", samples.subarray(start, start + 1_600), true);
      session.endOfTurn("fixture");
      const turn = session.claim();
      assert.isNotNull(turn);
      const events = yield* Effect.callback<TurnEvent[]>((resume) => {
        const seen: TurnEvent[] = [];
        turn!.subscribe((event) => {
          seen.push(event);
          if (event.type === "done" || event.type === "failed" || event.type === "interrupted")
            resume(Effect.succeed(seen));
        });
      });
      session.close();
      assert.strictEqual(events.at(-1)?.type, "done");
      assert.isAbove(events.filter((event) => event.type === "audio").length, 0);
      assert.isAbove(usage.length, 0);
      const usd = usage.reduce((sum, report) => sum + liveUsageCostUsd(model, report), 0);
      yield* Effect.logInfo(
        `Gemini: ${usage.length} usage reports, metered $${usd.toFixed(5)}`,
      ).pipe(Effect.annotateLogs({ usage: JSON.stringify(usage) }));
    }).pipe(
      Effect.provide([GeminiLive.layerWebSocketOpener, NodeServices.layer]),
      Effect.runPromise,
    ),
  60_000,
);
