import { VoiceFrontError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * LM Studio's CLI, under the home directory. `lms server start` brings up its
 * local server (waking the LM Studio app headless), and `lms ls --json`
 * reports each model's size.
 */
export const LMS_PATH_SEGMENTS = [".lmstudio", "bin", "lms"] as const;

/**
 * The environment `lms` runs in. Ctrl's desktop server runs as Electron with
 * ELECTRON_RUN_AS_NODE set, and LM Studio is an Electron app the CLI launches;
 * inheriting it makes LM Studio exit with "bad option" instead of starting.
 */
export const lmsEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  ELECTRON_RUN_AS_NODE: undefined,
});

const ModelList = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      modelKey: Schema.String,
      sizeBytes: Schema.Number,
      path: Schema.optionalKey(Schema.String),
    }),
  ),
);
export type ModelList = typeof ModelList.Type;
export const decodeModelList = Schema.decodeUnknownEffect(ModelList);

/**
 * The size guard. Ctrl only ever asks for `model`, and only when LM Studio
 * reports it downloaded and no larger than `maxBytes`; a model it cannot size
 * is refused too. Returns the model's size.
 */
export function checkModel(
  models: ModelList,
  model: string,
  maxBytes: number,
): { readonly sizeBytes: number } | VoiceFrontError {
  const entry = models.find((candidate) => candidate.modelKey === model);
  if (!entry)
    return new VoiceFrontError({
      reason: "model-missing",
      message: `LM Studio has no model "${model}". Download it with: lms get ${model}`,
    });
  if (!(entry.sizeBytes > 0) || entry.sizeBytes > maxBytes)
    return new VoiceFrontError({
      reason: "model-too-large",
      message: `"${model}" is ${formatGigabytes(entry.sizeBytes)}, over the ${formatGigabytes(
        maxBytes,
      )} limit for the front voice. Pick a smaller model.`,
    });
  return { sizeBytes: entry.sizeBytes };
}

const formatGigabytes = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/** True for endpoints on this machine, the only ones Ctrl starts a server for. */
export function isLocalEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  } catch {
    return false;
  }
}

/** Text deltas from an OpenAI-compatible streaming response, one SSE line at a time. */
export function sseDelta(line: string): string | null | "done" {
  if (!line.startsWith("data:")) return null;
  const data = line.slice(5).trim();
  if (data === "[DONE]") return "done";
  try {
    const parsed = JSON.parse(data) as {
      choices?: ReadonlyArray<{ delta?: { content?: unknown } }>;
    };
    const content = parsed.choices?.[0]?.delta?.content;
    return typeof content === "string" ? content : null;
  } catch {
    return null;
  }
}
