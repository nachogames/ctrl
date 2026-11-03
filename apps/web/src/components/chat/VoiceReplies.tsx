import { RegistryContext } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { use, useEffect, useRef, useSyncExternalStore } from "react";

import { replySpeaker } from "~/speech/replySpeaker";
import { useVoiceMode } from "~/speech/voiceMode";
import { useDictationEnvironmentId } from "~/state/dictation";
import { useThreadVisibleTurnItems } from "~/state/entities";
import { useSpeechState } from "~/state/speech";

/** A message first seen this recently, without streaming, still counts as a new reply. */
const FRESH_REPLY_MS = 60_000;

/**
 * Reads a thread's new replies aloud while voice mode is on and the environment's
 * dictation and spoken replies are ready. Everything already in the thread when voice mode
 * turns on, or when the thread opens, counts as heard. Renders nothing.
 */
export function VoiceReplies(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const registry = use(RegistryContext);
  const [voiceMode] = useVoiceMode();
  const { state } = useSpeechState(props.environmentId);
  // Matches the composer toggle: voice mode counts as off unless dictation is ready too.
  const dictationReady = useDictationEnvironmentId(props.environmentId) !== null;
  const active = voiceMode && dictationReady && state?.ready === true;
  const activeKey = useRef<string | null>(null);
  // Replies held while the front voice answers are fed again once it decides.
  const frontMode = useSyncExternalStore(replySpeaker.subscribe, replySpeaker.frontMode);
  const items = useThreadVisibleTurnItems(scopeThreadRef(props.environmentId, props.threadId));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- silences the reply speaker's audio when voice replies turn off
  useEffect(() => {
    if (!active) replySpeaker.stop();
  }, [active]);
  // Mounted per thread (keyed by ChatView), so leaving the thread stops reading it.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- silences the reply speaker's audio when the thread unmounts
  useEffect(() => () => replySpeaker.stop(), []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- feeds newly arrived replies into the reply speaker's audio queue
  useEffect(() => {
    // The thread's own replies, from its turn items: the chat view's message list holds no assistant text.
    const assistant = items.flatMap(({ item }) =>
      item.type === "assistant_message"
        ? [
            {
              id: item.messageId,
              text: item.text,
              streaming: item.streaming,
              updatedAtMs: DateTime.toEpochMillis(item.updatedAt),
            },
          ]
        : [],
    );
    const key = `${props.environmentId}:${props.threadId}`;
    if (!active) {
      activeKey.current = null;
      return;
    }
    if (activeKey.current !== key) {
      activeKey.current = key;
      replySpeaker.markHeard(assistant.map((message) => message.id));
      return;
    }
    // The speaker holds new replies while the front voice decides; feed them once it has.
    if (frontMode === "pending") return;
    // Only the newest few can be arriving; older history that loads late is not a reply.
    for (const message of assistant.slice(-3)) {
      if (
        replySpeaker.isNew(message.id) &&
        !message.streaming &&
        Date.now() - message.updatedAtMs > FRESH_REPLY_MS
      ) {
        replySpeaker.markHeard([message.id]);
        continue;
      }
      replySpeaker.feed({
        registry,
        environmentId: props.environmentId,
        messageId: message.id,
        text: message.text,
        streaming: message.streaming,
      });
    }
  }, [active, frontMode, items, props.environmentId, props.threadId, registry]);

  return null;
}
