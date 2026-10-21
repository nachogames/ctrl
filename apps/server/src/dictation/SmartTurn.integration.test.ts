import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as DictationArtifacts from "./DictationArtifacts.ts";
import * as SmartTurn from "./SmartTurn.ts";
import { turnModel } from "./models.ts";

/**
 * A directory holding the three `turnModel` files plus `complete.wav` and
 * `incomplete.wav` (16 kHz mono int16): a finished question, and one cut off
 * mid-sentence. Run explicitly; it exercises the real worker and model.
 */
const fixture = process.env.T3_SMART_TURN_FIXTURE;

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
  throw new Error("No data chunk.");
};

it.live.skipIf(!fixture)("tells a finished turn from a mid-sentence pause", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const classifier = yield* (yield* SmartTurn.SmartTurn).open;
    assert.isNotNull(classifier);
    const score = (name: string) =>
      fs
        .readFile(path.join(fixture!, name))
        .pipe(Effect.flatMap((bytes) => classifier!.probability(readWav(bytes))));
    const complete = yield* score("complete.wav");
    const incomplete = yield* score("incomplete.wav");
    assert.isAbove(complete!, 0.5);
    assert.isBelow(incomplete!, 0.5);
  }).pipe(
    Effect.provide(
      SmartTurn.layer.pipe(
        Layer.provide(
          Layer.succeed(DictationArtifacts.DictationArtifacts, {
            turnPaths: {
              model: `${fixture}/${turnModel.model}`,
              ortModule: `${fixture}/${turnModel.ortModule}`,
              wasm: `${fixture}/${turnModel.wasm}`,
            },
            turnInstalled: Effect.succeed(true),
          } as unknown as DictationArtifacts.DictationArtifacts["Service"]),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);
