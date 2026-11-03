import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronUpIcon } from "lucide-react";
import { use } from "react";

import { serverEnvironment } from "../../state/server";
import { speechEnvironment } from "../../state/speech";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "../ui/menu";
import { toastManager } from "../ui/toast";
import { composerFloatingLayerProps } from "./composerEventScope";

type QuickVoice = "gemini" | "local" | "off";

const CHOICES: ReadonlyArray<{ id: QuickVoice; label: string; description: string }> = [
  { id: "gemini", label: "Gemini Live", description: "A live voice answers right away." },
  { id: "local", label: "Local", description: "A small model in LM Studio, free." },
  { id: "off", label: "Off", description: "Only the agent's reply, read aloud." },
];

/**
 * Picks the quick voice that answers first in threads without Codex voice. It
 * is the machine's Front voice setting, so Settings → Devices shows the same.
 */
export function VoiceEnginePicker(props: { readonly environmentId: EnvironmentId }) {
  const registry = use(RegistryContext);
  const navigate = useNavigate();
  const front = useAtomValue(
    serverEnvironment.settingsValueAtom(props.environmentId),
    (settings) => settings?.voiceFront ?? null,
  );
  const update = useAtomCommand(serverEnvironment.updateSettings, {
    label: "Change quick voice",
  });
  if (front === null) return null;
  const value: QuickVoice = front.enabled ? front.engine : "off";

  const choose = async (next: QuickVoice) => {
    if (next === value) return;
    const result = await update({
      environmentId: props.environmentId,
      input: {
        patch: {
          voiceFront: next === "off" ? { enabled: false } : { enabled: true, engine: next },
        },
      },
    });
    if (result._tag !== "Success" || next !== "gemini") return;
    // Gemini needs a key, which only Settings can take.
    const status = await runAtomCommand(
      registry,
      speechEnvironment.frontStatus,
      { environmentId: props.environmentId, input: {} },
      { reportFailure: false },
    );
    if (status._tag === "Success" && status.value.gemini?.keySet === false)
      toastManager.add({
        type: "info",
        title: "Gemini Live needs an API key",
        description: "Add one under Front voice in Settings → Devices.",
        actionProps: {
          children: "Open settings",
          onClick: () => void navigate({ to: "/settings/devices" }),
        },
      });
  };

  return (
    <Menu modal={false}>
      <MenuTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Quick voice: ${CHOICES.find((choice) => choice.id === value)?.label}`}
          />
        }
      >
        <ChevronUpIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup side="top" align="end" className="max-w-64" {...composerFloatingLayerProps}>
        <MenuGroup>
          <MenuGroupLabel>Quick voice</MenuGroupLabel>
          <MenuRadioGroup
            aria-label="Quick voice"
            value={value}
            onValueChange={(next: string) => void choose(next as QuickVoice)}
          >
            {CHOICES.map((choice) => (
              <MenuRadioItem key={choice.id} value={choice.id} closeOnClick>
                <span className="flex items-center gap-3">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{choice.label}</span>
                    <span className="text-muted-foreground text-xs">{choice.description}</span>
                  </span>
                  <MenuRadioItemIndicator />
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
