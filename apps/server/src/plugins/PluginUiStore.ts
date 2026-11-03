/**
 * What plugins and Claude Code mods draw now: thread statuses, bands and toasts, in memory and
 * cleared with their producer. Clients get change signals and read current state, so a slow
 * client holds one pending signal, never a backlog of snapshots.
 */
import {
  PLUGIN_STATUS_MAX_ITEMS_PER_SOURCE,
  PLUGIN_STATUS_TEXT_MAX_LENGTH,
  PLUGIN_TOAST_MAX_RETAINED,
  type PluginBandEntry,
  type PluginBandsSnapshot,
  type PluginStatusEntry,
  type PluginStatusItem,
  type PluginToast,
  type PluginTone,
  type PluginUiElement,
  type PluginUiSource,
  pluginUiSourceKey,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

/** Most threads that can carry status entries at once; new threads past it are refused. */
const MAX_STATUS_ENTRIES = 512;
/** Most bands one thread can carry, one per source. */
const MAX_BANDS_PER_THREAD = 8;

export interface PluginToastInput {
  readonly source: PluginUiSource;
  readonly title: string;
  readonly body?: string | undefined;
  readonly tone?: PluginTone | undefined;
  readonly threadId?: ThreadId | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface PluginUiStoreShape {
  /** Sets one status item, or removes it when `text` is empty. */
  readonly setStatus: (
    threadId: ThreadId,
    source: PluginUiSource,
    item: { readonly key: string; readonly text: string } & Partial<
      Pick<PluginStatusItem, "tone" | "tooltip">
    >,
  ) => Effect.Effect<void>;
  /** Sets a source's band on a thread, or removes it with `null`. */
  readonly setBand: (
    threadId: ThreadId,
    source: PluginUiSource,
    tree: PluginUiElement | null,
  ) => Effect.Effect<void>;
  readonly toast: (input: PluginToastInput) => Effect.Effect<void>;
  /** Removes a source's statuses and bands, on one thread or on all of them. */
  readonly clearSource: (source: PluginUiSource, threadId?: ThreadId) => Effect.Effect<void>;
  readonly statuses: Effect.Effect<ReadonlyArray<PluginStatusEntry>>;
  readonly toasts: Effect.Effect<ReadonlyArray<PluginToast>>;
  /** Fires after any status or toast change; the caller reads the current state. */
  readonly changes: Stream.Stream<void>;
  readonly subscribeBands: (threadId: ThreadId) => Stream.Stream<PluginBandsSnapshot>;
}

export class PluginUiStore extends Context.Service<PluginUiStore, PluginUiStoreShape>()(
  "t3/plugins/PluginUiStore",
) {}

const ANSI_SEQUENCE = /\u001b\[[0-9;?]*[A-Za-z]/g;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;

/** One plain line: no control characters or ANSI styling, cut to `max`. */
const plainLine = (value: string, max: number): string => {
  const clean = value.replace(ANSI_SEQUENCE, "").replace(CONTROL_CHARACTERS, " ");
  const trimmed = clean.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};

/** A set of one-slot "changed" signals, one per subscriber. */
const makeSignals = () => {
  const signals = new Set<Queue.Queue<void>>();
  return {
    notify: Effect.forEach(signals, (signal) => Queue.offer(signal, undefined), { discard: true }),
    /** The value now, then again after every notify. */
    stream: <A>(read: () => A, onEmpty?: () => void): Stream.Stream<A> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const signal = yield* Queue.sliding<void>(1);
          signals.add(signal);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              signals.delete(signal);
              if (signals.size === 0) onEmpty?.();
            }),
          );
          return Stream.concat(Stream.sync(read), Stream.fromQueue(signal).pipe(Stream.map(read)));
        }),
      ),
    get size() {
      return signals.size;
    },
  };
};

export const make = Effect.sync(() => {
  // threadId -> sourceKey -> entry
  const statuses = new Map<ThreadId, Map<string, PluginStatusEntry>>();
  const bands = new Map<ThreadId, Map<string, PluginBandEntry>>();
  let toasts: ReadonlyArray<PluginToast> = [];
  let toastCount = 0;
  const global = makeSignals();
  const bandSignals = new Map<ThreadId, ReturnType<typeof makeSignals>>();

  const notifyBands = (threadId: ThreadId) => bandSignals.get(threadId)?.notify ?? Effect.void;

  const setStatus: PluginUiStoreShape["setStatus"] = (threadId, source, input) =>
    Effect.suspend(() => {
      const key = plainLine(input.key, 64);
      if (key === "") return Effect.void;
      const text = plainLine(input.text, PLUGIN_STATUS_TEXT_MAX_LENGTH);
      const sourceKey = pluginUiSourceKey(source);
      let thread = statuses.get(threadId);
      const previous = thread?.get(sourceKey);
      const others = (previous?.items ?? []).filter((item) => item.key !== key);
      if (text === "") {
        if (previous === undefined || others.length === previous.items.length) return Effect.void;
      } else if (thread === undefined && statuses.size >= MAX_STATUS_ENTRIES) {
        return Effect.void;
      }
      const items: PluginStatusItem[] =
        text === ""
          ? others
          : [
              ...others,
              {
                key,
                text,
                ...(input.tone === undefined ? {} : { tone: input.tone }),
                ...(input.tooltip === undefined ? {} : { tooltip: plainLine(input.tooltip, 240) }),
              },
            ]
              .toSorted((left, right) => left.key.localeCompare(right.key))
              .slice(0, PLUGIN_STATUS_MAX_ITEMS_PER_SOURCE);
      if (thread === undefined) {
        thread = new Map();
        statuses.set(threadId, thread);
      }
      if (items.length === 0) {
        thread.delete(sourceKey);
        if (thread.size === 0) statuses.delete(threadId);
      } else {
        thread.set(sourceKey, { threadId, source, items });
      }
      return global.notify;
    });

  const setBand: PluginUiStoreShape["setBand"] = (threadId, source, tree) =>
    Effect.suspend(() => {
      const sourceKey = pluginUiSourceKey(source);
      let thread = bands.get(threadId);
      if (tree === null) {
        if (thread?.delete(sourceKey) !== true) return Effect.void;
        if (thread.size === 0) bands.delete(threadId);
        return notifyBands(threadId);
      }
      if (thread === undefined) {
        thread = new Map();
        bands.set(threadId, thread);
      }
      if (!thread.has(sourceKey) && thread.size >= MAX_BANDS_PER_THREAD) return Effect.void;
      thread.set(sourceKey, { threadId, source, tree });
      return notifyBands(threadId);
    });

  const toast: PluginUiStoreShape["toast"] = Effect.fn("PluginUiStore.toast")(function* (input) {
    const title = plainLine(input.title, 80);
    if (title === "") return;
    const now = yield* DateTime.now;
    const body = input.body === undefined ? "" : plainLine(input.body, 240);
    const next: PluginToast = {
      id: `plugin-toast-${++toastCount}`,
      source: input.source,
      title,
      ...(body === "" ? {} : { body }),
      ...(input.tone === undefined ? {} : { tone: input.tone }),
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      createdAt: DateTime.formatIso(now),
    };
    toasts = [...toasts, next].slice(-PLUGIN_TOAST_MAX_RETAINED);
    yield* global.notify;
  });

  const clearSource: PluginUiStoreShape["clearSource"] = (source, onlyThreadId) =>
    Effect.suspend(() => {
      const sourceKey = pluginUiSourceKey(source);
      let statusChanged = false;
      const bandThreads: ThreadId[] = [];
      for (const [threadId, thread] of statuses) {
        if (onlyThreadId !== undefined && threadId !== onlyThreadId) continue;
        if (thread.delete(sourceKey)) statusChanged = true;
        if (thread.size === 0) statuses.delete(threadId);
      }
      for (const [threadId, thread] of bands) {
        if (onlyThreadId !== undefined && threadId !== onlyThreadId) continue;
        if (thread.delete(sourceKey)) bandThreads.push(threadId);
        if (thread.size === 0) bands.delete(threadId);
      }
      return Effect.andThen(
        statusChanged ? global.notify : Effect.void,
        Effect.forEach(bandThreads, notifyBands, { discard: true }),
      );
    });

  const readStatuses = () => [...statuses.values()].flatMap((thread) => [...thread.values()]);

  const subscribeBands: PluginUiStoreShape["subscribeBands"] = (threadId) =>
    Stream.suspend(() => {
      let signals = bandSignals.get(threadId);
      if (signals === undefined) {
        signals = makeSignals();
        bandSignals.set(threadId, signals);
      }
      const own = signals;
      return own.stream(
        (): PluginBandsSnapshot => ({ bands: [...(bands.get(threadId)?.values() ?? [])] }),
        () => {
          if (bandSignals.get(threadId) === own) bandSignals.delete(threadId);
        },
      );
    });

  return PluginUiStore.of({
    setStatus,
    setBand,
    toast,
    clearSource,
    statuses: Effect.sync(readStatuses),
    toasts: Effect.sync(() => toasts),
    changes: global.stream(() => undefined),
    subscribeBands,
  });
});

export const layer = Layer.effect(PluginUiStore, make);
