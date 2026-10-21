/**
 * One Gemini Live connection for one thread's hands-free conversation.
 *
 * It hears each turn through a speech gate, so only speech (and a little
 * around it) is sent and billed, and marks the turn with activityStart and
 * activityEnd from Ctrl's own end-of-turn detector. Gemini's answer for the
 * turn lands on a `LiveTurn`, which buffers it until the front's reply stream
 * reads it. A GoAway reconnects at the next quiet moment with the latest
 * resumption handle; any send while disconnected reconnects first.
 *
 * Plain callbacks rather than Effect, because the socket is callback-driven;
 * `GeminiLive` owns sessions and supplies the effects through the options.
 */
import type { GeminiLiveModel } from "@t3tools/contracts";

import type { LiveUsage } from "./geminiCost.ts";
import {
  activityEndMessage,
  activityStartMessage,
  audioMessage,
  parseServerMessage,
  TOOL_HAND_OFF,
  toolResponseMessage,
} from "./geminiProtocol.ts";
import { createSpeechGate, type SpeechGate } from "./speechGate.ts";

export interface LiveSocket {
  readonly send: (text: string) => void;
  readonly close: () => void;
}

export interface LiveSocketHandlers {
  readonly onOpen: () => void;
  readonly onMessage: (text: string) => void;
  readonly onClose: (info: { readonly code: number; readonly reason: string }) => void;
}

/** Opens a socket to Gemini Live; the URL, with its key, is bound by the caller. */
export type OpenLiveSocket = (handlers: LiveSocketHandlers) => LiveSocket;

export type TurnEvent =
  | { readonly type: "audio"; readonly data: string }
  /** Gemini handed the request to the thread's agent, so its reply should be read. */
  | { readonly type: "handoff" }
  | { readonly type: "interrupted" }
  | { readonly type: "done" }
  | { readonly type: "failed"; readonly message: string };

const isTerminal = (event: TurnEvent) =>
  event.type === "interrupted" || event.type === "done" || event.type === "failed";

/** A claimed turn older than this is someone else's, from a turn whose reply was never asked for. */
export const TURN_CLAIM_WINDOW_MS = 20_000;
/** Messages held while connecting; about a minute of 100 ms audio chunks. */
const MAX_QUEUED_MESSAGES = 600;

/** Gemini's answer to one user turn, buffered so a late reader still gets all of it. */
export class LiveTurn {
  #events: TurnEvent[] = [];
  #listeners = new Set<(event: TurnEvent) => void>();
  finished = false;
  claimed = false;
  readonly startedAtMs: number;
  constructor(startedAtMs: number) {
    this.startedAtMs = startedAtMs;
  }

  emit(event: TurnEvent) {
    if (this.finished) return;
    if (isTerminal(event)) this.finished = true;
    this.#events.push(event);
    for (const listener of this.#listeners) listener(event);
  }

  /** Replays what arrived so far, then delivers the rest as it comes. */
  subscribe(listener: (event: TurnEvent) => void): () => void {
    for (const event of this.#events) listener(event);
    if (!this.finished) this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }
}

interface Listening {
  readonly dictationId: string;
  readonly gate: SpeechGate;
  turn: LiveTurn | null;
  /** The connection dropped mid-turn; the rest of this turn is not sent. */
  lost: boolean;
}

export interface LiveSessionOptions {
  readonly model: GeminiLiveModel;
  readonly open: OpenLiveSocket;
  /** The setup message, resuming from `resumeHandle` when there is one. */
  readonly setup: (resumeHandle: string | null) => unknown;
  readonly now: () => number;
  /** Every `usageMetadata` report, for metering. */
  readonly onUsage: (usage: LiveUsage) => void;
  /** Runs a tool other than the hand-off, returning its result text. */
  readonly runTool: (name: string) => Promise<string>;
  /** The hand-off tool's result text. */
  readonly handOffResult: string;
  /** Gemini refused the session before it began (bad key, unknown model). The session is closed. */
  readonly onFatal: (message: string) => void;
  /** A turn ended without an answer. */
  readonly onTurnFailed: (message: string) => void;
  /** A turn was answered in full. */
  readonly onTurnDone: () => void;
}

export class LiveSession {
  #options: LiveSessionOptions;
  #socket: LiveSocket | null = null;
  #ready = false;
  #everReady = false;
  #dropping = false;
  #queue: string[] = [];
  #resumeHandle: string | null = null;
  #goAway = false;
  #listening: Listening | null = null;
  /** The turn whose answer Gemini is generating. */
  #responding: LiveTurn | null = null;
  #lastTurn: LiveTurn | null = null;
  #retired = false;
  closed = false;
  lastActivityMs: number;

  constructor(options: LiveSessionOptions) {
    this.#options = options;
    this.lastActivityMs = options.now();
  }

  get connected() {
    return this.#socket !== null;
  }

  /** Nothing is being heard or answered. */
  get idle() {
    return (
      !(this.#listening?.gate.open && !this.#listening.lost) &&
      (this.#responding === null || this.#responding.finished)
    );
  }

  /** Feeds one chunk of a dictation session's audio and whether the user is speaking in it. */
  audio(dictationId: string, samples: Float32Array, speech: boolean) {
    if (this.closed || this.#retired) return;
    this.lastActivityMs = this.#options.now();
    if (this.#listening?.dictationId !== dictationId) {
      this.#abandonListening();
      this.#listening = { dictationId, gate: createSpeechGate(), turn: null, lost: false };
      // Connecting while the user is still quiet hides the setup round trip.
      this.#ensureSocket();
    }
    const listening = this.#listening;
    if (listening.lost) return;
    const out = listening.gate.push(samples, speech);
    if (!out) return;
    if (out.start) {
      // Starting to speak interrupts any answer still playing out.
      this.#interruptResponding();
      const turn = new LiveTurn(this.#options.now());
      listening.turn = turn;
      this.#lastTurn = turn;
      this.#send(activityStartMessage);
    }
    for (const chunk of out.audio) this.#send(audioMessage(chunk));
  }

  /** The user finished the turn this dictation session heard: Gemini answers now. */
  endOfTurn(dictationId: string) {
    const listening = this.#listening;
    if (!listening || listening.dictationId !== dictationId) return;
    this.#listening = null;
    if (!listening.gate.open || listening.lost || !listening.turn) return;
    this.#send(activityEndMessage);
    this.#responding = listening.turn;
  }

  /** The dictation session ended without finishing its turn. */
  cancel(dictationId: string) {
    if (this.#listening?.dictationId === dictationId) this.#abandonListening();
  }

  /** The most recent turn, once, if it is recent enough to be the one just spoken. */
  claim(): LiveTurn | null {
    const turn = this.#lastTurn;
    if (!turn || turn.claimed) return null;
    if (this.#options.now() - turn.startedAtMs > TURN_CLAIM_WINDOW_MS) return null;
    turn.claimed = true;
    return turn;
  }

  /** Takes no new turns, and closes once the current one is answered. */
  retire() {
    this.#retired = true;
    this.#abandonListening();
    if (this.idle) this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.#fail("The voice session closed.", false);
    this.#queue = [];
    const socket = this.#socket;
    this.#socket = null;
    this.#ready = false;
    socket?.close();
  }

  #abandonListening() {
    const listening = this.#listening;
    this.#listening = null;
    if (!listening?.gate.open || listening.lost) return;
    // Close the activity so the next one can open; its answer goes unread.
    this.#send(activityEndMessage);
    listening.turn?.emit({ type: "failed", message: "The turn was cancelled." });
  }

  #interruptResponding() {
    const responding = this.#responding;
    this.#responding = null;
    if (responding && !responding.finished) responding.emit({ type: "interrupted" });
  }

  /** Ends unfinished turns; `report` counts it as Gemini failing. */
  #fail(message: string, report = true) {
    const turns = [this.#responding, this.#listening?.turn];
    this.#responding = null;
    if (this.#listening) this.#listening.lost = true;
    for (const turn of turns)
      if (turn && !turn.finished) {
        turn.emit({ type: "failed", message });
        if (report) this.#options.onTurnFailed(message);
      }
  }

  #send(message: unknown) {
    if (this.closed) return;
    const text = JSON.stringify(message);
    if (this.#ready && this.#socket) {
      this.#socket.send(text);
      return;
    }
    if (this.#queue.length < MAX_QUEUED_MESSAGES) this.#queue.push(text);
    this.#ensureSocket();
  }

  #ensureSocket() {
    if (this.#socket || this.closed) return;
    this.#ready = false;
    this.#everReady = false;
    this.#dropping = false;
    const socket = this.#options.open({
      onOpen: () => {
        if (this.#socket !== socket) return;
        socket.send(JSON.stringify(this.#options.setup(this.#resumeHandle)));
      },
      onMessage: (text) => {
        if (this.#socket === socket) this.#message(text);
      },
      onClose: (info) => {
        if (this.#socket !== socket) return;
        this.#socket = null;
        this.#ready = false;
        if (this.closed || this.#dropping) return;
        const reason = info.reason || `closed with code ${info.code}`;
        if (!this.#everReady && this.#resumeHandle !== null) {
          // The handle expired; the next send starts a fresh session.
          this.#resumeHandle = null;
          this.#fail(`Gemini could not resume the session: ${reason}`);
          return;
        }
        if (!this.#everReady) {
          this.closed = true;
          this.#fail(`Gemini refused the session: ${reason}`);
          this.#options.onFatal(reason);
          return;
        }
        this.#fail(`Gemini disconnected: ${reason}`);
      },
    });
    this.#socket = socket;
  }

  /** Drops the connection on purpose; the next send reconnects, resuming the session. */
  #reconnectLater() {
    const socket = this.#socket;
    this.#goAway = false;
    if (!socket) return;
    this.#dropping = true;
    this.#socket = null;
    this.#ready = false;
    socket.close();
  }

  #message(text: string) {
    this.lastActivityMs = this.#options.now();
    const message = parseServerMessage(text);
    if (message.usage) this.#options.onUsage(message.usage);
    if (message.resumeHandle) this.#resumeHandle = message.resumeHandle;
    if (message.setupComplete) {
      this.#ready = true;
      this.#everReady = true;
      const queued = this.#queue;
      this.#queue = [];
      for (const item of queued) this.#socket?.send(item);
    }
    const turn = this.#responding;
    for (const data of message.audio) turn?.emit({ type: "audio", data });
    for (const call of message.toolCalls) this.#toolCall(call, turn);
    if (message.error) this.#fail(`Gemini reported an error: ${message.error}`);
    if (message.interrupted || message.turnComplete) {
      this.#responding = null;
      if (turn && !turn.finished) {
        turn.emit(message.interrupted ? { type: "interrupted" } : { type: "done" });
        if (!message.interrupted) this.#options.onTurnDone();
      }
    }
    if (message.goAway) this.#goAway = true;
    if (this.#goAway && this.idle) this.#reconnectLater();
    if (this.#retired && this.idle) this.close();
  }

  #toolCall(call: { readonly id: string; readonly name: string }, turn: LiveTurn | null) {
    const model = this.#options.model;
    if (call.name === TOOL_HAND_OFF) {
      turn?.emit({ type: "handoff" });
      // Gemini already said the agent is on it; the result needs no words.
      this.#send(toolResponseMessage(model, call, this.#options.handOffResult, "SILENT"));
      return;
    }
    void this.#options
      .runTool(call.name)
      .catch(() => "That information is not available right now.")
      .then((result) => this.#send(toolResponseMessage(model, call, result, null)));
  }
}
