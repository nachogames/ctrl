// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- the fake remote server runs on the SDK's Node transport, and the test plays the browser.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as RemoteMcpServers from "./RemoteMcpServers.ts";

const TOKEN = "test-token";

const json = (response: NodeHttp.ServerResponse, body: unknown) =>
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));

const readBody = (request: NodeHttp.IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => resolve(body));
  });

/**
 * A remote MCP server with one `echo` tool that accepts only `Bearer test-token`,
 * plus a minimal OAuth server (registration, PKCE authorize, token) that issues it.
 */
const startRemoteServer = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<NodeHttp.Server>((resolve) => {
        const challenges = new Map<string, string>();
        const http = NodeHttp.createServer(async (request, response) => {
          const base = `http://${request.headers.host}`;
          const url = new URL(request.url ?? "/", base);
          if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
            return json(response, { resource: `${base}/mcp`, authorization_servers: [base] });
          }
          if (url.pathname === "/.well-known/oauth-authorization-server") {
            return json(response, {
              issuer: base,
              authorization_endpoint: `${base}/authorize`,
              token_endpoint: `${base}/token`,
              registration_endpoint: `${base}/register`,
              response_types_supported: ["code"],
              grant_types_supported: ["authorization_code", "refresh_token"],
              code_challenge_methods_supported: ["S256"],
              token_endpoint_auth_methods_supported: ["none"],
            });
          }
          if (url.pathname === "/register") {
            const metadata = JSON.parse(await readBody(request));
            return json(response, { ...metadata, client_id: "client-1" });
          }
          if (url.pathname === "/authorize") {
            const code = `code-${challenges.size}`;
            challenges.set(code, url.searchParams.get("code_challenge") ?? "");
            const back = new URL(url.searchParams.get("redirect_uri") ?? "");
            back.searchParams.set("code", code);
            back.searchParams.set("state", url.searchParams.get("state") ?? "");
            return response.writeHead(302, { location: back.href }).end();
          }
          if (url.pathname === "/token") {
            const form = new URLSearchParams(await readBody(request));
            const challenge = NodeCrypto.createHash("sha256")
              .update(form.get("code_verifier") ?? "")
              .digest("base64url");
            if (challenges.get(form.get("code") ?? "") !== challenge) {
              return response.writeHead(400).end(JSON.stringify({ error: "invalid_grant" }));
            }
            return json(response, { access_token: TOKEN, token_type: "Bearer", expires_in: 3600 });
          }
          if (request.headers.authorization !== `Bearer ${TOKEN}`) {
            response.writeHead(401).end();
            return;
          }
          const server = new Server(
            { name: "remote", version: "1.0.0" },
            { capabilities: { tools: {} } },
          );
          server.setRequestHandler(ListToolsRequestSchema, () => ({
            tools: [
              {
                name: "echo",
                description: "Echoes its text.",
                inputSchema: { type: "object", properties: { text: { type: "string" } } },
              },
            ],
          }));
          server.setRequestHandler(CallToolRequestSchema, (call) => ({
            content: [{ type: "text", text: String(call.params.arguments?.text) }],
          }));
          const transport = new StreamableHTTPServerTransport({});
          response.on("close", () => void transport.close());
          void server
            .connect(transport as Transport)
            .then(() => transport.handleRequest(request, response));
        });
        http.listen(0, "127.0.0.1", () => resolve(http));
      }),
  ),
  (http) => Effect.promise(() => new Promise<void>((resolve) => http.close(() => resolve()))),
).pipe(
  Effect.map((http) => `http://127.0.0.1:${(http.address() as NodeNet.AddressInfo).port}/mcp`),
);

/** The browser's visit to the sign-in page, which the fake server approves at once. */
const visitSignInPage = (url: string) => fetch(url, { redirect: "manual" });

const makeService = (stored = new Map<string, Uint8Array>()) =>
  Effect.gen(function* () {
    const secrets = ServerSecretStore.ServerSecretStore.of({
      get: (name) => Effect.sync(() => Option.fromNullishOr(stored.get(name))),
      set: (name, value) => Effect.sync(() => void stored.set(name, value)),
      create: (name, value) => Effect.sync(() => void stored.set(name, value)),
      getOrCreateRandom: () => Effect.die("unused"),
      remove: (name) => Effect.sync(() => void stored.delete(name)),
    });
    const service = yield* RemoteMcpServers.make.pipe(
      Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
    );
    return { service, stored };
  }).pipe(Effect.provide(PlatformNodeCrypto.layer));

const addInput = (url: string, bearerToken: string) => ({
  id: "notes",
  name: "Notes",
  url,
  authMode: "bearer" as const,
  bearerToken,
});

it.effect("proxies a bearer server's tools until the server is removed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const url = yield* startRemoteServer;
      const { service, stored } = yield* makeService();

      yield* service.add(addInput(url, TOKEN));
      const [server] = (yield* service.list).servers;
      assert.strictEqual(server?.state, "connected");
      assert.strictEqual(server?.toolCount, 1);
      assert.deepStrictEqual(
        service.tools().map((tool) => tool.name),
        ["notes_echo"],
      );
      assert.isTrue(stored.has("remote-mcp-servers"));

      assert.isTrue(service.isVisible("notes_echo"));

      const result = yield* service.callTool("notes_echo", { text: "hello" });
      assert.deepStrictEqual((result as { content: unknown }).content, [
        { type: "text", text: "hello" },
      ]);

      yield* service.remove({ id: "notes" });
      assert.isFalse(service.isVisible("notes_echo"));
      assert.deepStrictEqual(service.tools(), []);
      assert.deepStrictEqual((yield* service.list).servers, []);
    }),
  ),
);

it.effect("reports a rejected bearer token instead of exposing tools", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const url = yield* startRemoteServer;
      const { service } = yield* makeService();

      yield* service.add(addInput(url, "wrong"));
      const [server] = (yield* service.list).servers;
      assert.strictEqual(server?.state, "error");
      assert.strictEqual(server?.message, "The server rejected the credential.");
      assert.deepStrictEqual(service.tools(), []);
    }),
  ),
);

it.effect("asks an OAuth server to sign in before connecting", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const url = yield* startRemoteServer;
      const { service } = yield* makeService();

      yield* service.add({ ...addInput(url, TOKEN), authMode: "oauth", bearerToken: undefined });
      assert.strictEqual((yield* service.list).servers[0]?.state, "needs_authorization");
    }),
  ),
);

it.effect("finishes an OAuth sign-in that a server restart interrupted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const url = yield* startRemoteServer;
      const stored = new Map<string, Uint8Array>();
      const before = yield* makeService(stored);
      yield* before.service.add({
        ...addInput(url, TOKEN),
        authMode: "oauth",
        bearerToken: undefined,
      });
      const { authorizationUrl } = yield* before.service.authorize({
        id: "notes",
        callbackOrigin: "http://localhost:3773",
      });
      const approved = yield* Effect.promise(() => visitSignInPage(authorizationUrl!));
      const callback = new URL(approved.headers.get("location")!);
      assert.strictEqual(callback.pathname, "/oauth/remote-mcp/callback");

      // A fresh service over the same secret store stands in for the restarted server.
      const after = yield* makeService(stored);
      const result = yield* after.service.completeAuthorization({
        state: callback.searchParams.get("state")!,
        code: callback.searchParams.get("code")!,
      });
      assert.strictEqual(result.name, "Notes");
      assert.strictEqual((yield* after.service.list).servers[0]?.state, "connected");
      assert.deepStrictEqual(
        after.service.tools().map((tool) => tool.name),
        ["notes_echo"],
      );

      const reused = yield* after.service
        .completeAuthorization({
          state: callback.searchParams.get("state")!,
          code: callback.searchParams.get("code")!,
        })
        .pipe(Effect.flip);
      assert.include(reused.message, "expired");
    }),
  ),
);

it("keeps proxied tool names within provider limits", () => {
  const long = RemoteMcpServers.exposedToolName("notes", "x".repeat(80), "abcdef0123");
  assert.isAtMost(long.length, 50);
  assert.isTrue(long.endsWith("_abcdef"));
  assert.strictEqual(RemoteMcpServers.exposedToolName("notes", "a.b c", "0"), "notes_a_b_c");
});

it("rejects add requests the server cannot use", () => {
  const valid = addInput("https://mcp.example.com/mcp", TOKEN);
  assert.isUndefined(RemoteMcpServers.invalidAddInput(valid));
  assert.isDefined(RemoteMcpServers.invalidAddInput({ ...valid, id: "Has Space" }));
  assert.isDefined(RemoteMcpServers.invalidAddInput({ ...valid, url: "ftp://example.com" }));
  assert.isDefined(RemoteMcpServers.invalidAddInput({ ...valid, bearerToken: " " }));
  assert.isDefined(
    RemoteMcpServers.invalidAddInput({ ...valid, url: "http://mcp.example.com/mcp" }),
  );
  assert.isUndefined(
    RemoteMcpServers.invalidAddInput({ ...valid, url: "http://localhost:3000/mcp" }),
  );
});

it("shows clients only where a server is, never a key in its URL", () => {
  assert.strictEqual(
    RemoteMcpServers.displayUrl("https://user:pass@mcp.example.com/s/secret/mcp?api_key=k"),
    "https://mcp.example.com",
  );
});
