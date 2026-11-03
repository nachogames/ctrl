import * as NodeWorkerThreads from "node:worker_threads";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DictationArtifacts from "./DictationArtifacts.ts";
import { MEL_BINS, MEL_FRAMES, smartTurnFeatures } from "./smartTurnFeatures.ts";

/** Longest a verdict may take before it is dropped; the turn's silence cap covers the rest. */
const VERDICT_TIMEOUT = "2 seconds";

/** Judges whether a hands-free turn is finished from its last 8 seconds of audio. */
export interface TurnClassifier {
  /** Probability that `audio` (16 kHz mono, the turn so far) ends a finished turn; null when the model could not answer. */
  readonly probability: (audio: Float32Array) => Effect.Effect<number | null>;
}

/** Pipecat's Smart Turn v3, the semantic half of hands-free end of turn. */
export class SmartTurn extends Context.Service<
  SmartTurn,
  {
    /** The classifier, or null while it is not installed here (turns then end on fixed silence). */
    readonly open: Effect.Effect<TurnClassifier | null>;
  }
>()("t3/dictation/SmartTurn") {}

/**
 * Runs in a worker thread so the ~160 ms single-threaded WebAssembly
 * inference never blocks the server. Plain CommonJS, loaded with `eval`, so
 * the bundled server needs no separate worker file.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const ready = (async () => {
  const ort = await import(pathToFileURL(workerData.ortModule).href);
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmBinary = fs.readFileSync(workerData.wasm);
  const session = await ort.InferenceSession.create(fs.readFileSync(workerData.model));
  return { ort, session };
})();
ready.catch((error) => parentPort.postMessage({ id: -1, error: String(error) }));
parentPort.on("message", async ({ id, features }) => {
  try {
    const { ort, session } = await ready;
    const input = new ort.Tensor("float32", features, [1, ${MEL_BINS}, ${MEL_FRAMES}]);
    const output = await session.run({ [session.inputNames[0]]: input });
    parentPort.postMessage({ id, probability: Number(output[session.outputNames[0]].data[0]) });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error) });
  }
});
`;

type WorkerReply =
  | { readonly id: number; readonly probability: number }
  | { readonly id: number; readonly error: string };

const make = Effect.gen(function* () {
  const artifacts = yield* DictationArtifacts.DictationArtifacts;
  const scope = yield* Effect.scope;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  let worker: NodeWorkerThreads.Worker | null = null;
  /** Set once the worker failed to load the model; turns stay on fixed silence until restart. */
  let broken = false;
  /** One background install attempt per server run, so a failing download is not retried every turn. */
  let installTried = false;
  let nextId = 0;
  const waiting = new Map<number, (probability: number | null) => void>();

  const fail = (reason: string) => {
    if (broken) return;
    broken = true;
    for (const resolve of waiting.values()) resolve(null);
    waiting.clear();
    void worker?.terminate();
    worker = null;
    runFork(
      Effect.logWarning("The turn model failed; hands-free turns end on fixed silence.").pipe(
        Effect.annotateLogs({ cause: reason }),
      ),
    );
  };

  const start = () => {
    const created = new NodeWorkerThreads.Worker(WORKER_SOURCE, {
      eval: true,
      workerData: artifacts.turnPaths,
    });
    // An idle classifier must not keep the server process alive.
    created.unref();
    created.on("message", (reply: WorkerReply) => {
      if ("error" in reply) {
        // A load failure (id -1) or a failed run both mean the model is unusable here.
        fail(reply.error);
        return;
      }
      const resolve = waiting.get(reply.id);
      waiting.delete(reply.id);
      resolve?.(Number.isFinite(reply.probability) ? reply.probability : null);
    });
    created.on("error", (error) => fail(String(error)));
    created.on("exit", (code) => {
      if (worker === created && code !== 0) fail(`exited with ${code}`);
    });
    return created;
  };

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      void worker?.terminate();
      worker = null;
    }),
  );

  const probability = (audio: Float32Array) =>
    Effect.callback<number | null>((resume) => {
      if (broken) return resume(Effect.succeed(null));
      worker ??= start();
      const id = nextId++;
      // Features are a few tens of milliseconds of main-thread work; inference is the slow half.
      const features = smartTurnFeatures(audio);
      waiting.set(id, (value) => resume(Effect.succeed(value)));
      worker.postMessage({ id, features }, [features.buffer]);
      return Effect.sync(() => {
        waiting.delete(id);
      });
    }).pipe(
      Effect.timeoutOrElse({
        duration: VERDICT_TIMEOUT,
        orElse: () => Effect.succeed(null),
      }),
    );

  const classifier: TurnClassifier = { probability };

  const open = Effect.gen(function* () {
    if (broken) return null;
    const installed = yield* artifacts.turnInstalled.pipe(Effect.orElseSucceed(() => false));
    if (installed) {
      // Load the model while the user is still talking, so the first pause's verdict is quick.
      worker ??= start();
      return classifier;
    }
    // Hands-free voice is already installed, so fetch its small turn model in the
    // background; this turn and any until it lands end on fixed silence.
    if (!installTried && artifacts.supported) {
      installTried = true;
      yield* artifacts.installTurn.pipe(
        Effect.tap(() => Effect.logInfo("Installed the turn model for hands-free voice.")),
        Effect.catchTags({
          DictationError: (error) =>
            Effect.logWarning("Could not install the turn model.").pipe(
              Effect.annotateLogs({ cause: error.message }),
            ),
        }),
        Effect.forkIn(scope),
      );
    }
    return null;
  });

  return SmartTurn.of({ open });
});

export const layer = Layer.effect(SmartTurn, make);

/** No turn model: hands-free turns end on fixed silence. */
export const layerUnavailable = Layer.succeed(SmartTurn, { open: Effect.succeed(null) });
