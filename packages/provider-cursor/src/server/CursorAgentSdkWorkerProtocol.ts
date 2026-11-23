import type {
  AgentMessage,
  AgentOptions,
  InteractionUpdate,
  RunResult,
  SDKCustomTool,
  SDKCustomToolContext,
  SDKCustomToolResult,
  SDKJsonValue,
  SDKUserMessage,
  SendOptions,
  SteerAckOutcome,
} from "@cursor/sdk";
import type { OrchestrationV2ProviderSession, ThreadId } from "@t3tools/contracts";

import type {
  CursorAgentSdkOpenInput,
  CursorAgentSdkProtocolLogEvent,
  CursorAgentSdkTextGenerateInput,
  CursorContextUsage,
} from "./CursorAgentSdk.ts";
import { type CursorSdkErrorKind, getCursorSdkErrorKind, tagCursorSdkError } from "./sdk.ts";

export type SerializedBackgroundShellEvent =
  | {
      readonly type: "started";
      readonly id: string;
      readonly pid: number | undefined;
      readonly command: string;
    }
  | {
      readonly type: "ended";
      readonly id: string;
      readonly pid: number | undefined;
      readonly command: string;
      readonly stopped: boolean;
      readonly exitCode: number | undefined;
      readonly outputPath: string | undefined;
    };

export interface SerializedWorkerError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly code?: string;
  readonly status?: number;
  readonly sdkErrorKind?: CursorSdkErrorKind;
  readonly cause?: SerializedWorkerError;
}

export interface SerializedRunnerFailure {
  readonly method: string;
  readonly cause: SerializedWorkerError;
}

export type SerializedRunResult = Omit<RunResult, "error"> & {
  readonly error?: SerializedWorkerError | undefined;
};

export type CursorWorkerRequest =
  | {
      readonly id: number;
      readonly type: "open";
      readonly operation: CursorAgentSdkOpenInput["operation"];
      readonly agentId?: string;
      readonly storeCwd?: string;
      readonly options: AgentOptions;
      readonly threadId: ThreadId;
      readonly providerSessionId: OrchestrationV2ProviderSession["id"];
    }
  | {
      readonly id: number;
      readonly type: "send";
      readonly sessionId: number;
      readonly message: string | SDKUserMessage;
      readonly options?: Omit<SendOptions, "onDelta">;
      readonly summarize?: boolean;
      readonly resume?: boolean;
      readonly listenBackgroundShells?: boolean;
    }
  | {
      readonly id: number;
      readonly type: "stopBackgroundShell";
      readonly sessionId: number;
      readonly shellId: string;
    }
  | {
      readonly id: number;
      readonly type: "steer";
      readonly sendId: number;
      readonly text: string;
    }
  | {
      readonly id: number;
      readonly type: "cancel";
      readonly sendId: number;
    }
  | {
      readonly id: number;
      readonly type: "listMessages";
      readonly sessionId: number;
    }
  | {
      readonly id: number;
      readonly type: "readContextUsage";
      readonly sessionId: number;
    }
  | {
      readonly id: number;
      readonly type: "runCheckpointed";
      readonly sessionId: number;
      readonly runId?: string;
    }
  | {
      readonly id: number;
      readonly type: "rewindAfterRun";
      readonly sessionId: number;
      readonly runId: string;
    }
  | {
      readonly id: number;
      readonly type: "closeSession";
      readonly sessionId: number;
    }
  | {
      readonly id: number;
      readonly type: "cancelTextGenerate";
      readonly textGenerateId: number;
    }
  | ({
      readonly id: number;
      readonly type: "customToolResult";
      readonly callId: number;
    } & (
      | { readonly ok: true; readonly result: SDKCustomToolResult }
      | { readonly ok: false; readonly error: SerializedWorkerError }
    ))
  | {
      /** Closes every session and exits the worker. */
      readonly id: number;
      readonly type: "close";
    }
  | ({
      readonly id: number;
      readonly type: "textGenerate";
    } & CursorAgentSdkTextGenerateInput);

export type CursorWorkerResponsePayload =
  | { readonly agentId: string }
  | { readonly runId: string; readonly agentId: string }
  | SteerAckOutcome
  | ReadonlyArray<AgentMessage>
  | CursorContextUsage
  | SerializedRunResult
  | boolean
  | null;

export type CursorWorkerMessage =
  | {
      readonly type: "response";
      readonly id: number;
      readonly ok: true;
      readonly result: CursorWorkerResponsePayload;
    }
  | {
      readonly type: "response";
      readonly id: number;
      readonly ok: false;
      readonly error: SerializedRunnerFailure;
    }
  | {
      readonly type: "delta";
      readonly sendId: number;
      readonly update: InteractionUpdate;
    }
  | {
      readonly type: "startupPhase";
      readonly sendId: number;
      readonly phase: string;
    }
  | {
      readonly type: "runDone";
      readonly sendId: number;
      readonly ok: true;
      readonly result: SerializedRunResult;
    }
  | {
      readonly type: "runDone";
      readonly sendId: number;
      readonly ok: false;
      readonly error: SerializedRunnerFailure;
    }
  | {
      readonly type: "protocolLog";
      readonly providerSessionId: OrchestrationV2ProviderSession["id"];
      readonly sessionId?: number;
      readonly event: CursorAgentSdkProtocolLogEvent;
    }
  | {
      readonly type: "backgroundShell";
      readonly sessionId: number;
      readonly event: SerializedBackgroundShellEvent;
    }
  | {
      /** Custom tool callbacks stay in the server; the worker asks it to run one. */
      readonly type: "customToolCall";
      readonly sendId: number;
      readonly callId: number;
      readonly toolName: string;
      readonly args: Record<string, SDKJsonValue>;
      readonly context: SDKCustomToolContext;
    };

const MAX_ERROR_CAUSE_DEPTH = 8;

function safeGetProperty(target: object, key: string): unknown {
  try {
    return Reflect.get(target, key);
  } catch {
    return undefined;
  }
}

function safeErrorString(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return String(value);
  } catch {
    return "[Unserializable error]";
  }
}

export function serializeWorkerError(
  cause: unknown,
  depth = 0,
  seen = new Set<object>(),
): SerializedWorkerError {
  if (typeof cause === "object" && cause !== null) {
    if (seen.has(cause)) {
      return { name: "Error", message: "[Circular error cause]" };
    }
    seen.add(cause);
    const rawName = safeGetProperty(cause, "name");
    const rawMessage = safeGetProperty(cause, "message");
    const rawStack = safeGetProperty(cause, "stack");
    const rawCode = safeGetProperty(cause, "code");
    const rawStatus = safeGetProperty(cause, "status");
    const rawCause = depth < MAX_ERROR_CAUSE_DEPTH ? safeGetProperty(cause, "cause") : undefined;
    let sdkErrorKind: CursorSdkErrorKind | undefined;
    try {
      sdkErrorKind = getCursorSdkErrorKind(cause);
    } catch {
      sdkErrorKind = undefined;
    }
    return {
      name: typeof rawName === "string" && rawName.length > 0 ? rawName : "Error",
      message: typeof rawMessage === "string" ? rawMessage : safeErrorString(cause),
      ...(typeof rawStack === "string" ? { stack: rawStack } : {}),
      ...(typeof rawCode === "string" ? { code: rawCode } : {}),
      ...(typeof rawStatus === "number" ? { status: rawStatus } : {}),
      ...(sdkErrorKind === undefined ? {} : { sdkErrorKind }),
      ...(rawCause === undefined ? {} : { cause: serializeWorkerError(rawCause, depth + 1, seen) }),
    };
  }
  return {
    name: "Error",
    message: safeErrorString(cause),
  };
}

export function deserializeWorkerError(serialized: SerializedWorkerError): Error {
  const error = new Error(
    serialized.message,
    serialized.cause === undefined
      ? undefined
      : { cause: deserializeWorkerError(serialized.cause) },
  );
  error.name = serialized.name;
  if (serialized.stack !== undefined) {
    error.stack = serialized.stack;
  }
  if (serialized.code !== undefined) {
    Reflect.set(error, "code", serialized.code);
  }
  if (serialized.status !== undefined) {
    Reflect.set(error, "status", serialized.status);
  }
  if (serialized.sdkErrorKind !== undefined) {
    tagCursorSdkError(error, serialized.sdkErrorKind);
  }
  return error;
}

export function serializeRunResult(result: RunResult): SerializedRunResult {
  if (result.error === undefined) {
    return result as SerializedRunResult;
  }
  return {
    ...result,
    error: serializeWorkerError(result.error),
  };
}

export function deserializeRunResult(result: SerializedRunResult): RunResult {
  if (result.error === undefined) {
    return result as RunResult;
  }
  return {
    ...result,
    error: deserializeWorkerError(result.error),
  } as RunResult;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64");
  }
  return value;
}

export function encodeWorkerFrame(frame: CursorWorkerRequest | CursorWorkerMessage): string {
  return `${JSON.stringify(frame, jsonReplacer)}\n`;
}

export function decodeWorkerFrame(line: string): unknown {
  return JSON.parse(line);
}

type CustomToolResultRequest = Extract<CursorWorkerRequest, { type: "customToolResult" }>;
type WorkerSendOptions = NonNullable<Extract<CursorWorkerRequest, { type: "send" }>["options"]>;

/**
 * Worker half of custom tools. `execute` does not survive the JSON frame, so each bridged tool
 * posts a `customToolCall` and waits for the server's `customToolResult`.
 */
export function makeCustomToolBridge(writeMessage: (message: CursorWorkerMessage) => void) {
  const pending = new Map<
    number,
    {
      readonly resolve: (result: SDKCustomToolResult) => void;
      readonly reject: (error: Error) => void;
    }
  >();
  let nextCallId = 0;

  const bridgeTools = (
    sendId: number,
    tools: Record<string, SDKCustomTool>,
  ): Record<string, SDKCustomTool> =>
    Object.fromEntries(
      Object.entries(tools).map(([toolName, tool]) => [
        toolName,
        {
          ...tool,
          execute: (args, context) =>
            new Promise<SDKCustomToolResult>((resolve, reject) => {
              const callId = ++nextCallId;
              pending.set(callId, { resolve, reject });
              writeMessage({ type: "customToolCall", sendId, callId, toolName, args, context });
            }),
        } satisfies SDKCustomTool,
      ]),
    );

  return {
    bridgeSendOptions: (sendId: number, options: WorkerSendOptions): WorkerSendOptions => {
      const tools = options.local?.customTools;
      if (tools === undefined) return options;
      return { ...options, local: { ...options.local, customTools: bridgeTools(sendId, tools) } };
    },
    settle: (req: CustomToolResultRequest): void => {
      const call = pending.get(req.callId);
      pending.delete(req.callId);
      if (call === undefined) return;
      if (req.ok) call.resolve(req.result);
      else call.reject(deserializeWorkerError(req.error));
    },
  };
}
