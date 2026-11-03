/**
 * GeminiLive - the optional Gemini Live engine of the front voice: one live
 * session per hands-free thread, metered from Gemini's usage reports. At the
 * monthly cap, with no key, or on failure, the local front answers and the user
 * hears why once. The API key stays in the server secret store.
 */
import {
  isHomeThreadId,
  type GeminiLiveModel,
  type ThreadId,
  VoiceFrontError,
  type VoiceFrontGeminiStatus,
  type VoiceFrontSettings,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as Dictation from "../dictation/Dictation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { contextText, geminiInstructions, workerName } from "./frontPrompt.ts";
import { liveUsageCostUsd, spendMonth, type LiveUsage } from "./geminiCost.ts";
import { liveUrl, redactKey, setupMessage, TOOL_CHECK_THREADS } from "./geminiProtocol.ts";
import {
  LiveSession,
  type LiveSocket,
  type LiveSocketHandlers,
  type LiveTurn,
} from "./LiveSession.ts";
import * as VoiceFrontContext from "./VoiceFrontContext.ts";

export const GEMINI_KEY_SECRET = "voice-front-gemini-api-key";
export const SPEND_FILE_NAME = "voice-front-spend.json";
/** A session this long without audio or messages closes, even if the client never said it ended. */
const SESSION_IDLE_MS = 120_000;
/** After Gemini refused a session, new ones wait this long, unless the key or model changes. */
const FAILURE_RETRY_MS = 120_000;

/** Why the local front answers a turn the user meant for Gemini. */
export type FallbackReason = "capped" | "no-key" | "failed";

const NOTICES: Record<FallbackReason, (capUsd: number) => string> = {
  capped: (cap) =>
    `Gemini reached this month's ${formatUsd(cap)} limit, so the local voice takes over until next month.`,
  "no-key": () => "Gemini has no API key yet, so the local voice is answering.",
  failed: () => "Gemini isn't answering, so the local voice is taking over.",
};

const formatUsd = (usd: number) => `$${usd.toFixed(2)}`;

/** Opens WebSockets to Gemini; the default uses Node's WebSocket, tests a fake. */
export class LiveSocketOpener extends Context.Service<
  LiveSocketOpener,
  { readonly open: (url: string, handlers: LiveSocketHandlers) => LiveSocket }
>()("t3/voiceFront/GeminiLive/LiveSocketOpener") {}

export const layerWebSocketOpener = Layer.succeed(LiveSocketOpener, {
  open: (url, handlers) => {
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    const decoder = new TextDecoder();
    socket.addEventListener("open", () => handlers.onOpen());
    socket.addEventListener("message", (event) =>
      handlers.onMessage(
        typeof event.data === "string" ? event.data : decoder.decode(event.data as ArrayBuffer),
      ),
    );
    socket.addEventListener("close", (event) =>
      handlers.onClose({ code: event.code, reason: redactKey(event.reason) }),
    );
    // A failed connection also closes, which reports it.
    socket.addEventListener("error", () => undefined);
    return {
      send: (text) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(text);
      },
      close: () => socket.close(),
    };
  },
});

const SpendFile = Schema.fromJsonString(
  Schema.Struct({ months: Schema.Record(Schema.String, Schema.Number) }),
);
const decodeSpendFile = Schema.decodeUnknownEffect(SpendFile);
const encodeSpendFile = Schema.encodeEffect(SpendFile);

export type ClaimResult =
  | { readonly _tag: "turn"; readonly turn: LiveTurn }
  /** `notice`: what to tell the user, the first time this reason applies. */
  | { readonly _tag: "fallback"; readonly notice: string | null };

export class GeminiLive extends Context.Service<
  GeminiLive,
  {
    readonly status: Effect.Effect<VoiceFrontGeminiStatus>;
    readonly setKey: (key: string | null) => Effect.Effect<void, VoiceFrontError>;
    /** Gemini's answer to the voice turn this thread just heard, or why the local front answers. */
    readonly claim: (threadId: ThreadId) => Effect.Effect<ClaimResult>;
    /** The notice for `reason` if the user has not heard it since Gemini last worked. */
    readonly notice: (reason: FallbackReason) => Effect.Effect<string | null>;
    /** Hands-free voice ended in this thread. */
    readonly end: (threadId: ThreadId) => Effect.Effect<void>;
  }
>()("t3/voiceFront/GeminiLive") {}

export const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const dictation = yield* Dictation.Dictation;
  const contexts = yield* VoiceFrontContext.VoiceFrontContext;
  const opener = yield* LiveSocketOpener;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const services = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(services);
  /** The effect clock, read from the socket's callbacks. */
  const now = () => Effect.runSyncWith(services)(Clock.currentTimeMillis);
  const spendPath = path.join(config.stateDir, SPEND_FILE_NAME);
  const writes = yield* Semaphore.make(1);

  const sessions = new Map<ThreadId, { session: LiveSession; model: GeminiLiveModel }>();
  /** Which session each live dictation session feeds; null when it goes to no one. */
  const routes = new Map<string, LiveSession | null>();
  const shownNotices = new Set<FallbackReason>();
  let problem: { readonly message: string; readonly atMs: number } | null = null;

  // Spend for the current month, from disk. Older months are kept for the record.
  const months: Record<string, number> = yield* fs.readFileString(spendPath).pipe(
    Effect.flatMap(decodeSpendFile),
    Effect.map((file) => ({ ...file.months })),
    Effect.orElseSucceed(() => ({})),
  );
  const monthSpend = (nowMs: number) => months[spendMonth(nowMs)] ?? 0;

  const readSettings = settingsService.getSettings.pipe(
    Effect.map((current) => current.voiceFront),
    Effect.orElseSucceed((): VoiceFrontSettings | null => null),
  );
  const readKey = secrets.get(GEMINI_KEY_SECRET).pipe(
    Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes).trim())),
    Effect.map(Option.filter((key) => key.length > 0)),
    Effect.orElseSucceed(() => Option.none<string>()),
  );

  /** Set at shutdown, after the last write, so a write queued behind it cannot outlive the server. */
  let stopped = false;
  const writeSpend = Effect.gen(function* () {
    if (stopped) return;
    const contents = yield* encodeSpendFile({ months: { ...months } });
    yield* writeFileStringAtomically({ filePath: spendPath, contents: `${contents}\n` });
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not save the front voice's Gemini spend.").pipe(
        Effect.annotateLogs({ cause: String(cause) }),
      ),
    ),
  );
  const persistSpend = writes.withPermit(writeSpend);

  const closeAll = () => {
    for (const { session } of sessions.values()) session.close();
    sessions.clear();
  };

  /** Adds one usage report to this month's spend, at once, and saves it in the background. */
  const meter = (model: GeminiLiveModel, cap: number, usage: LiveUsage) => {
    const month = spendMonth(now());
    const before = months[month] ?? 0;
    const after = before + liveUsageCostUsd(model, usage);
    months[month] = after;
    if (before < cap && after >= cap) {
      for (const { session } of sessions.values()) session.retire();
      runFork(
        Effect.logInfo("The front voice reached its monthly Gemini cap.").pipe(
          Effect.annotateLogs({ month, spendUsd: after, capUsd: cap }),
        ),
      );
    }
    runFork(persistSpend);
  };

  const openSession = (threadId: ThreadId, current: VoiceFrontSettings, key: string) =>
    Effect.sync(() => {
      const kind = isHomeThreadId(threadId) ? "shift" : "thread";
      const worker = workerName(kind);
      const spoken = worker === "Shift" ? "Shift" : "The agent";
      const model = current.geminiModel;
      const url = liveUrl(key);
      const session: LiveSession = new LiveSession({
        model,
        open: (handlers) => opener.open(url, handlers),
        setup: (resumeHandle) =>
          setupMessage({ model, instructions: geminiInstructions(kind), worker, resumeHandle }),
        now,
        onUsage: (usage) => meter(model, current.monthlyCapUsd, usage),
        runTool: (name) =>
          name === TOOL_CHECK_THREADS
            ? Effect.runPromiseWith(services)(Effect.map(contexts.load(threadId), contextText))
            : Promise.resolve(`There is no tool named ${name}.`),
        handOffResult: `Sent. ${spoken} is working on it, and its reply is read aloud when it is ready.`,
        onFatal: (message) => {
          problem = { message: redactKey(message), atMs: now() };
          if (sessions.get(threadId)?.session === session) sessions.delete(threadId);
          runFork(
            Effect.logWarning("Gemini refused the front voice's session.").pipe(
              Effect.annotateLogs({ reason: redactKey(message), model }),
            ),
          );
        },
        onTurnFailed: (message) => {
          problem = { message: redactKey(message), atMs: now() };
        },
        onTurnDone: () => {
          problem = null;
          shownNotices.clear();
        },
      });
      sessions.set(threadId, { session, model });
      return session;
    });

  /** The session a new dictation session in this thread should feed, opening one if it may. */
  const route = Effect.fnUntraced(function* (threadId: ThreadId) {
    const current = yield* readSettings;
    const existing = sessions.get(threadId);
    if (!current?.enabled || current.engine !== "gemini") {
      existing?.session.close();
      sessions.delete(threadId);
      return null;
    }
    const nowMs = yield* Clock.currentTimeMillis;
    if (monthSpend(nowMs) >= current.monthlyCapUsd) return null;
    if (existing && !existing.session.closed && existing.model === current.geminiModel)
      return existing.session;
    existing?.session.close();
    sessions.delete(threadId);
    if (problem && nowMs - problem.atMs < FAILURE_RETRY_MS) return null;
    const key = yield* readKey;
    if (Option.isNone(key)) return null;
    return yield* openSession(threadId, current, key.value);
  });

  const handle = Effect.fnUntraced(function* (event: Dictation.VoiceAudioEvent) {
    if (event._tag === "audio") {
      let target = routes.get(event.sessionId);
      if (target === undefined) {
        target = yield* route(event.threadId);
        routes.set(event.sessionId, target);
      }
      target?.audio(event.sessionId, event.samples, event.speech);
      return;
    }
    const target = routes.get(event.sessionId);
    if (event._tag === "endOfTurn") target?.endOfTurn(event.sessionId);
    else {
      target?.cancel(event.sessionId);
      routes.delete(event.sessionId);
    }
  });

  yield* dictation.voiceAudio.pipe(
    Stream.runForEach((event) =>
      handle(event).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("The Gemini front voice could not take a chunk of audio.").pipe(
            Effect.annotateLogs({ cause: redactKey(String(cause)) }),
          ),
        ),
      ),
    ),
    Effect.forkScoped,
  );

  // Sessions whose client vanished without saying so close on their own.
  yield* Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    for (const [threadId, { session }] of sessions)
      if (session.closed || (session.idle && nowMs - session.lastActivityMs > SESSION_IDLE_MS)) {
        session.close();
        sessions.delete(threadId);
      }
  }).pipe(Effect.repeat(Schedule.spaced("30 seconds")), Effect.forkScoped);
  yield* Effect.addFinalizer(() =>
    Effect.sync(closeAll).pipe(
      // Waits for a write in flight, then saves the final state once.
      Effect.andThen(
        writes.withPermit(
          writeSpend.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                stopped = true;
              }),
            ),
          ),
        ),
      ),
    ),
  );

  const notice = Effect.fn("GeminiLive.notice")(function* (reason: FallbackReason) {
    if (shownNotices.has(reason)) return null;
    shownNotices.add(reason);
    const current = yield* readSettings;
    return NOTICES[reason](current?.monthlyCapUsd ?? 0);
  });

  const fallback = (notice: string | null): ClaimResult => ({ _tag: "fallback", notice });
  const claim = Effect.fn("GeminiLive.claim")(function* (threadId: ThreadId) {
    const current = yield* readSettings;
    const nowMs = yield* Clock.currentTimeMillis;
    if (current && monthSpend(nowMs) >= current.monthlyCapUsd)
      return fallback(yield* notice("capped"));
    const turn = sessions.get(threadId)?.session.claim() ?? null;
    if (turn) return { _tag: "turn", turn } satisfies ClaimResult as ClaimResult;
    if (Option.isNone(yield* readKey)) return fallback(yield* notice("no-key"));
    return fallback(problem ? yield* notice("failed") : null);
  });

  const status = Effect.gen(function* () {
    const current = yield* readSettings;
    const nowMs = yield* Clock.currentTimeMillis;
    const cap = current?.monthlyCapUsd ?? 0;
    const spend = monthSpend(nowMs);
    return {
      keySet: Option.isSome(yield* readKey),
      monthSpendUsd: spend,
      monthlyCapUsd: cap,
      capped: spend >= cap,
      problem: problem?.message ?? null,
    };
  });

  const setKey = (key: string | null) =>
    (key === null
      ? secrets.remove(GEMINI_KEY_SECRET)
      : secrets.set(GEMINI_KEY_SECRET, new TextEncoder().encode(key))
    ).pipe(
      Effect.mapError(
        () =>
          new VoiceFrontError({
            reason: "key-store-failed",
            message: "Could not save the Gemini API key on this machine.",
          }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          closeAll();
          problem = null;
          shownNotices.clear();
        }),
      ),
    );

  const end = (threadId: ThreadId) =>
    Effect.sync(() => {
      sessions.get(threadId)?.session.close();
      sessions.delete(threadId);
    });

  return GeminiLive.of({ status, setKey, claim, notice, end });
});

const layerWithoutSocket = Layer.effect(GeminiLive, make);
export const layer = layerWithoutSocket.pipe(Layer.provide(layerWebSocketOpener));
