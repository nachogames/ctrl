import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import type { ComposerCommandItem } from "./ComposerCommandMenu";
import {
  searchSlashCommandItems,
  PROMPT_START_ONLY_HINT,
  slashCommandItemsForPromptPosition,
} from "./composerSlashCommandSearch";

describe("searchSlashCommandItems", () => {
  const claudeDriver = ProviderDriverKind.make("claudeAgent");

  it("lists every provider command mid-message, skills first and start-only ones hinted", () => {
    const items = [
      {
        id: "slash:model",
        type: "slash-command",
        command: "model",
        label: "/model",
        description: "Switch model",
      },
      {
        id: "provider-slash-command:claudeAgent:compact",
        type: "provider-slash-command",
        provider: claudeDriver,
        command: { name: "compact" },
        label: "/compact",
        description: "Compact the conversation",
      },
      {
        id: "provider-slash-command:claudeAgent:simplify",
        type: "provider-slash-command",
        provider: claudeDriver,
        command: { name: "simplify", skill: true },
        label: "/simplify",
        description: "Clean up the diff",
      },
      {
        id: "skill:claudeAgent:unslop",
        type: "skill",
        provider: claudeDriver,
        skill: {
          name: "unslop",
          path: "/skills/unslop/SKILL.md",
          enabled: true,
        },
        label: "/skill:unslop",
        description: "Cut AI tells from writing",
      },
    ] satisfies Array<
      Extract<ComposerCommandItem, { type: "slash-command" | "provider-slash-command" | "skill" }>
    >;

    const midMessage = slashCommandItemsForPromptPosition(items, false);
    expect(
      midMessage.map((item) => [
        item.id,
        item.type === "provider-slash-command" ? item.hint : undefined,
      ]),
    ).toEqual([
      ["provider-slash-command:claudeAgent:simplify", undefined],
      ["skill:claudeAgent:unslop", undefined],
      ["slash:model", undefined],
      ["provider-slash-command:claudeAgent:compact", PROMPT_START_ONLY_HINT],
    ]);
    // Ranking still applies on top of the mid-message order.
    expect(searchSlashCommandItems(midMessage, "compact").map((item) => item.id)).toEqual([
      "provider-slash-command:claudeAgent:compact",
    ]);
    expect(slashCommandItemsForPromptPosition(items, true).map((item) => item.id)).toEqual([
      "slash:model",
      "provider-slash-command:claudeAgent:compact",
      "provider-slash-command:claudeAgent:simplify",
      "skill:claudeAgent:unslop",
    ]);
  });

  it("offers plugin-qualified Claude skills mid-message and matches either half of the name", () => {
    const items = slashCommandItemsForPromptPosition(
      [
        {
          id: "skill:claudeAgent:superpowers:brainstorming",
          type: "skill",
          provider: claudeDriver,
          skill: {
            name: "superpowers:brainstorming",
            path: "/plugins/superpowers/skills/brainstorming/SKILL.md",
            enabled: true,
            scope: "plugin",
          },
          label: "/skill:superpowers:brainstorming",
          description: "Explore intent first",
        },
      ],
      false,
    );

    for (const query of ["brainstorm", "superpowers", "superpowers:brain"]) {
      expect(searchSlashCommandItems(items, query).map((item) => item.id)).toEqual([
        "skill:claudeAgent:superpowers:brainstorming",
      ]);
    }
  });
});
