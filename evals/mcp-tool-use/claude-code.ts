// @effect-diagnostics nodeBuiltinImport:off
/**
 * Runs an eval sample through the real Claude Code, by the Agent SDK as T3 does, so the run uses
 * the signed-in Claude subscription instead of an API key. T3's tools come from a local MCP server
 * that answers with the eval's results; shell commands print the shell simulator's output.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  query,
  type HookCallback,
  type HookJSONOutput,
  type Options,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

export type McpTool = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
};
export type ToolAnswer = { readonly text: string; readonly isError: boolean };
type Session = {
  readonly tools: ReadonlyArray<McpTool>;
  readonly call: (name: string, input: unknown) => Promise<ToolAnswer>;
};

/** A local MCP server over streamable HTTP, like T3's. Each sample gets its own path. */
export const startMcpServer = async () => {
  const sessions = new Map<string, Session>();
  const handle = async (session: Session, message: Record<string, unknown>) => {
    const params = (message.params ?? {}) as Record<string, unknown>;
    switch (message.method) {
      case "initialize":
        return {
          protocolVersion: params.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "t3-code", version: "eval" },
        };
      case "ping":
        return {};
      case "tools/list":
        return { tools: session.tools };
      case "tools/call": {
        const answer = await session.call(String(params.name), params.arguments ?? {});
        return { content: [{ type: "text", text: answer.text }], isError: answer.isError };
      }
      default:
        return undefined;
    }
  };
  const server = NodeHttp.createServer((request, response) => {
    const session = sessions.get(request.url?.split("/").at(-1) ?? "");
    if (session === undefined || request.method !== "POST") {
      response.writeHead(session === undefined ? 404 : 405).end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const message = JSON.parse(body) as Record<string, unknown>;
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      void handle(session, message).then(
        (result) => {
          const reply =
            result === undefined
              ? { error: { code: -32601, message: `Unknown method ${String(message.method)}` } }
              : { result };
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...reply }));
        },
        (error: unknown) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32603, message: String(error) },
            }),
          );
        },
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  let next = 0;
  return {
    open: (session: Session) => {
      const id = String(next++);
      sessions.set(id, session);
      return { url: `http://127.0.0.1:${port}/mcp/${id}`, close: () => sessions.delete(id) };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

/** The signed-in `claude` binary. The SDK's bundled one is optional and often missing. */
export const claudeBinary = () =>
  process.env.CLAUDE_CODE_BIN ??
  NodeChildProcess.execFileSync("which", ["claude"], { encoding: "utf8" }).trim();

/** Claude Code's environment without API credentials, so it signs in with the subscription. */
const subscriptionEnv = () => {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) {
    // A parent Claude Code session's own variables would change the child's behavior.
    if (key.startsWith("ANTHROPIC_") || key.startsWith("CLAUDE_CODE_") || key === "CLAUDECODE") {
      delete env[key];
    }
  }
  // Keeps the account's claude.ai connectors out of the tool list.
  return { ...env, ENABLE_CLAUDEAI_MCP_SERVERS: "false" };
};

/**
 * Options every eval session shares: no user or project settings (so no CLAUDE.md, plugins,
 * skills or hooks of the person running it), only the MCP servers given, and no prompts.
 */
const evalOptions = (): Options => ({
  pathToClaudeCodeExecutable: claudeBinary(),
  env: subscriptionEnv(),
  settingSources: [],
  strictMcpConfig: true,
  permissionMode: "bypassPermissions",
  allowDangerouslySkipPermissions: true,
  persistSession: false,
});

export type Usage = { input: number; output: number; cacheWrite: number; cacheRead: number };
const usageOf = (message: Extract<SDKMessage, { type: "result" }>): Usage => ({
  input: message.usage.input_tokens,
  output: message.usage.output_tokens,
  cacheWrite: message.usage.cache_creation_input_tokens,
  cacheRead: message.usage.cache_read_input_tokens,
});

/** One structured answer from a model with no tools, as the shell simulator needs. */
export const structuredAnswer = async (options: {
  readonly model: string;
  readonly system: string;
  readonly prompt: string;
  readonly schema: Record<string, unknown>;
}) => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-eval-shell-"));
  try {
    for await (const message of query({
      prompt: options.prompt,
      options: {
        ...evalOptions(),
        cwd: directory,
        model: options.model,
        effort: "low",
        systemPrompt: options.system,
        tools: [],
        outputFormat: { type: "json_schema", schema: options.schema },
        maxTurns: 3,
      },
    })) {
      if (message.type !== "result") continue;
      if (message.subtype !== "success") throw new Error(`Shell simulator: ${message.subtype}`);
      return { value: message.structured_output, text: message.result, usage: usageOf(message) };
    }
    throw new Error("Shell simulator: no result.");
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
};

export type ClaudeCodeSample = {
  /** T3's Claude options for the thread: its system prompt append and hooks. */
  readonly t3Options: Options;
  readonly model: string;
  readonly effort: string;
  readonly maxTurns: number;
  readonly prompt: string;
  readonly sandbox: Awaited<ReturnType<typeof makeSandbox>>;
  readonly tools: ReadonlyArray<McpTool>;
  readonly callT3: (name: string, input: unknown) => Promise<ToolAnswer>;
  /** The simulated output of a shell command, "Exit code N" first when it fails. */
  readonly shell: (tool: string, input: unknown) => Promise<string>;
  readonly onCall: (step: number, id: string, name: string, input: unknown) => void;
  readonly onResult: (id: string, output: string, isError: boolean) => void;
  /** True once the sample has failed for good, so the run can stop. */
  readonly settled: () => boolean;
  readonly mcp: Awaited<ReturnType<typeof startMcpServer>>;
};

const EXIT = /^Exit code (\d+)\n?/;
const NO_OUTPUT = "(Bash completed with no output)";
const PATH_KEYS = ["file_path", "path", "notebook_path"] as const;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const allow = (updatedInput?: Record<string, unknown>): HookJSONOutput => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    ...(updatedInput === undefined ? {} : { updatedInput }),
  },
});
const deny = (reason: string): HookJSONOutput => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  },
});

/** A sandbox holding the fake world's files, so file tools read and edit them for real. */
export const makeSandbox = async (files: Readonly<Record<string, string>>) => {
  // macOS links tmpdir under /private; Claude Code reports the real path.
  const root = await NodeFSP.mkdtemp(
    NodePath.join(await NodeFSP.realpath(NodeOS.tmpdir()), "t3-eval-"),
  );
  const cwd = NodePath.join(root, "app");
  const outputs = NodePath.join(root, "outputs");
  await NodeFSP.mkdir(outputs, { recursive: true });
  for (const [file, content] of Object.entries({ "README.md": "# app\n", ...files })) {
    const at = NodePath.join(cwd, file);
    await NodeFSP.mkdir(NodePath.dirname(at), { recursive: true });
    await NodeFSP.writeFile(at, content);
  }
  return { cwd, outputs, dispose: () => NodeFSP.rm(root, { recursive: true, force: true }) };
};

/** Runs one sample. The agent's calls and results reach the caller through the callbacks. */
export const runClaudeCodeSample = async (sample: ClaudeCodeSample) => {
  const { cwd, outputs } = sample.sandbox;
  const session = sample.mcp.open({ tools: sample.tools, call: sample.callT3 });
  const abort = new AbortController();
  let outputCount = 0;
  // Shell commands never run: each prints the simulator's output from a file outside the sandbox.
  const preToolUse: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse" || !isRecord(input.tool_input)) return allow();
    const toolInput = input.tool_input;
    if (typeof toolInput.command === "string") {
      const output = await sample.shell(input.tool_name, toolInput);
      const code = EXIT.exec(output)?.[1];
      const body = output.replace(EXIT, "");
      const file = NodePath.join(outputs, `${outputCount++}.txt`);
      await NodeFSP.writeFile(file, body === NO_OUTPUT ? "" : `${body}\n`);
      const command = `cat '${file}'${code === undefined ? "" : `; exit ${code}`}`;
      return allow({ ...toolInput, command, run_in_background: false });
    }
    for (const key of PATH_KEYS) {
      const value = toolInput[key];
      if (typeof value !== "string") continue;
      const resolved = NodePath.resolve(cwd, value);
      if (resolved !== cwd && !resolved.startsWith(`${cwd}${NodePath.sep}`)) {
        return deny(`${value} is outside the working directory.`);
      }
    }
    return allow();
  };
  const postToolUse: HookCallback = async (input) => {
    if (input.hook_event_name === "PostToolUse") {
      const response = input.tool_response;
      sample.onResult(
        input.tool_use_id,
        typeof response === "string" ? response : JSON.stringify(response),
        false,
      );
    } else if (input.hook_event_name === "PostToolUseFailure") {
      sample.onResult(input.tool_use_id, input.error, true);
    }
    if (sample.settled()) abort.abort();
    return {};
  };
  // Each sample is a fresh session; T3's thread id is not one.
  const { sessionId: _sessionId, resume: _resume, ...t3Options } = sample.t3Options;
  const t3Hooks = t3Options.hooks ?? {};
  const said: Array<string> = [];
  const transcript: Array<SDKMessage> = [];
  let stopReason = "unknown";
  let finalText = "";
  let usage: Usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  let step = -1;
  let lastMessageId: string | undefined;
  try {
    for await (const message of query({
      prompt: sample.prompt,
      options: {
        ...t3Options,
        ...evalOptions(),
        cwd,
        additionalDirectories: [],
        model: sample.model,
        effort: sample.effort as NonNullable<Options["effort"]>,
        maxTurns: sample.maxTurns,
        abortController: abort,
        includePartialMessages: false,
        disallowedTools: ["WebFetch", "WebSearch"],
        mcpServers: { "t3-code": { type: "http", url: session.url } },
        hooks: {
          ...t3Hooks,
          PreToolUse: [...(t3Hooks.PreToolUse ?? []), { hooks: [preToolUse], timeout: 600 }],
          PostToolUse: [...(t3Hooks.PostToolUse ?? []), { hooks: [postToolUse] }],
          PostToolUseFailure: [...(t3Hooks.PostToolUseFailure ?? []), { hooks: [postToolUse] }],
        },
      },
    })) {
      transcript.push(message);
      if (message.type === "assistant" && message.parent_tool_use_id === null) {
        // Claude Code streams one message per content block; blocks of one response share an id.
        if (message.message.id !== lastMessageId) {
          lastMessageId = message.message.id;
          step++;
        }
        for (const block of message.message.content) {
          if (block.type === "text") said.push(block.text);
          if (block.type === "tool_use") sample.onCall(step, block.id, block.name, block.input);
        }
      }
      if (message.type === "result") {
        usage = usageOf(message);
        if (message.subtype === "success") {
          stopReason = message.stop_reason ?? "end_turn";
          finalText = message.result;
        } else {
          stopReason = message.subtype === "error_max_turns" ? "max_steps" : message.subtype;
        }
      }
    }
  } catch (error) {
    // The SDK throws after a max-turns result; an API run grades that as running out of steps.
    if (!abort.signal.aborted && stopReason !== "max_steps") throw error;
  } finally {
    session.close();
  }
  if (abort.signal.aborted) stopReason = "failed_early";
  return { text: said.join("\n\n"), finalText, stopReason, usage, transcript };
};
