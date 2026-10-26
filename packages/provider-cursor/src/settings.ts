import { CustomModelSetting, makeProviderSettingsSchema, TrimmedString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const CursorSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    // Preserve V1 CLI fields when V2's SDK rewrites shared settings.
    binaryPath: Schema.optionalKey(TrimmedString).pipe(
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    apiEndpoint: Schema.optionalKey(TrimmedString).pipe(
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    // Ctrl: opt-in, since it copies saved OAuth tokens between folders.
    shareMcpSignIns: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({
        title: "Share MCP sign-ins across folders",
        description:
          "Sign in to a server from ~/.cursor/mcp.json once, and every Cursor thread uses it: before a thread first runs in a folder, the newest sign-in is copied there. Servers a project's own .cursor/mcp.json defines still sign in per folder. Sign-ins stay in your Cursor data folder on this machine.",
        providerSettingsForm: { control: "switch" },
      }),
    ),
    // Ctrl: opt-in, since it adds a hook to ~/.cursor/hooks.json.
    askBeforeMcpTools: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({
        title: "Ask before MCP tools outside your allowlist",
        description:
          "Shows an approval card before a Cursor thread calls an MCP tool your Cursor allowlist doesn't allow, even in Full access. Uses the Cursor app's MCP allowlist, plus any permissions in ~/.cursor/cli-config.json. Adds a hook to ~/.cursor/hooks.json that does nothing in the Cursor app.",
        providerSettingsForm: { control: "switch" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: [],
  },
);
export type CursorSettings = typeof CursorSettings.Type;
