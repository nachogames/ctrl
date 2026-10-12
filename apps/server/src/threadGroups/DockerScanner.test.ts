import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as DockerScanner from "./DockerScanner.ts";

const dbRow = JSON.stringify({
  ID: "a1b2c3",
  Names: "auth-db-1",
  Image: "postgres:16",
  Labels:
    "com.docker.compose.project=auth,com.docker.compose.service=db,com.docker.compose.project.working_dir=/a/wt,com.example.dsn=postgres://u@h/db?sslmode=disable",
  Ports: "0.0.0.0:5432->5432/tcp, :::5432->5432/tcp",
  State: "running",
});
const plainRow = JSON.stringify({
  ID: "d4e5f6",
  Names: "redis",
  Labels: "",
  Ports: "6379/tcp, 127.0.0.1:8000-8001->8000-8001/tcp, 0.0.0.0:9000->9000/udp",
});

const output = (stdout: string, code = 0): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const listWith = (run: ProcessRunner.ProcessRunner["Service"]["run"]) =>
  DockerScanner.DockerScanner.pipe(
    Effect.flatMap((scanner) => scanner.listContainers),
    Effect.provide(
      DockerScanner.layer.pipe(Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, { run }))),
    ),
  );

describe("DockerScanner parsing", () => {
  it("reads compose labels, keeping an `=` inside a value", () => {
    const labels = DockerScanner.parseDockerLabels(
      "com.docker.compose.service=db,com.example.dsn=postgres://u@h/db?sslmode=disable",
    );
    expect(labels.get("com.docker.compose.service")).toBe("db");
    expect(labels.get("com.example.dsn")).toBe("postgres://u@h/db?sslmode=disable");
  });

  it("extracts published host TCP ports once each", () => {
    expect(DockerScanner.parseDockerPorts("0.0.0.0:5432->5432/tcp, :::5432->5432/tcp")).toEqual([
      5432,
    ]);
    expect(
      DockerScanner.parseDockerPorts(
        "6379/tcp, 127.0.0.1:8000-8001->8000-8001/tcp, 0.0.0.0:9000->9000/udp",
      ),
    ).toEqual([8000]);
  });

  it("parses one container per line and skips lines that are not JSON rows", () => {
    expect(DockerScanner.parseDockerPs(`${dbRow}\nnot json\n${plainRow}\n`)).toEqual([
      {
        id: "a1b2c3",
        name: "auth-db-1",
        service: "db",
        workingDir: "/a/wt",
        publishedPorts: [5432],
      },
      { id: "d4e5f6", name: "redis", service: null, workingDir: null, publishedPorts: [8000] },
    ]);
  });
});

describe("DockerScanner.listContainers", () => {
  it.effect("asks docker for JSON rows", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    return listWith((input) => {
      calls.push([input.command, ...input.args]);
      return Effect.succeed(output(`${dbRow}\n`));
    }).pipe(
      Effect.tap((containers) =>
        Effect.sync(() => {
          expect(containers.map((container) => container.id)).toEqual(["a1b2c3"]);
          expect(calls).toEqual([["docker", "ps", "--format", "{{json .}}"]]);
        }),
      ),
    );
  });

  it.effect("returns no containers when the docker binary is missing", () =>
    listWith((input) =>
      Effect.fail(
        new ProcessRunner.ProcessSpawnError({
          command: input.command,
          argumentCount: input.args.length,
          cause: PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            description: "docker is not installed",
          }),
        }),
      ),
    ).pipe(Effect.tap((containers) => Effect.sync(() => expect(containers).toEqual([])))),
  );

  it.effect("returns no containers when docker exits non-zero", () =>
    listWith(() => Effect.succeed(output(`${dbRow}\n`, 1))).pipe(
      Effect.tap((containers) => Effect.sync(() => expect(containers).toEqual([]))),
    ),
  );

  it.effect("returns no containers when docker times out", () =>
    listWith((input) =>
      Effect.fail(
        new ProcessRunner.ProcessTimeoutError({
          command: input.command,
          argumentCount: input.args.length,
          timeoutMs: 3_000,
        }),
      ),
    ).pipe(Effect.tap((containers) => Effect.sync(() => expect(containers).toEqual([])))),
  );
});
