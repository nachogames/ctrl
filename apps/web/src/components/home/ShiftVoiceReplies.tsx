import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { use, useEffect, useRef } from "react";

import { shiftSpeaker } from "~/speech/shiftSpeaker";
import { useShiftVoiceMode } from "~/speech/voiceMode";
import { useSpeechState } from "~/state/speech";
import type { ChatMessage } from "~/types";

/** A message first seen this recently, without streaming, still counts as a new reply. */
const FRESH_REPLY_MS = 60_000;

/**
 * Reads Shift's new replies aloud while voice mode is on and the environment's
 * spoken replies are ready. Everything already in the thread when voice mode
 * turns on, or when the thread opens, counts as heard. Renders nothing.
 */
export function ShiftVoiceReplies(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messages: ReadonlyArray<ChatMessage>;
}) {
  const registry = use(RegistryContext);
  const [voiceMode] = useShiftVoiceMode();
  const { state } = useSpeechState(props.environmentId);
  const active = voiceMode && state?.ready === true;
  const activeKey = useRef<string | null>(null);

  useEffect(() => {
    if (!voiceMode) shiftSpeaker.stop();
  }, [voiceMode]);
  // Mounted per thread (keyed by ChatView), so leaving the thread stops reading it.
  useEffect(() => () => shiftSpeaker.stop(), []);

  useEffect(() => {
    const assistant = props.messages.filter((message) => message.role === "assistant");
    const key = `${props.environmentId}:${props.threadId}`;
    if (!active) {
      activeKey.current = null;
      return;
    }
    if (activeKey.current !== key) {
      activeKey.current = key;
      shiftSpeaker.markHeard(assistant.map((message) => message.id));
      return;
    }
    // Only the newest few can be arriving; older history that loads late is not a reply.
    for (const message of assistant.slice(-3)) {
      if (
        shiftSpeaker.isNew(message.id) &&
        !message.streaming &&
        Date.now() - Date.parse(message.createdAt) > FRESH_REPLY_MS
      ) {
        shiftSpeaker.markHeard([message.id]);
        continue;
      }
      shiftSpeaker.feed({
        registry,
        environmentId: props.environmentId,
        messageId: message.id,
        text: message.text,
        streaming: message.streaming,
      });
    }
  }, [active, props.environmentId, props.threadId, props.messages, registry]);

  return null;
}
