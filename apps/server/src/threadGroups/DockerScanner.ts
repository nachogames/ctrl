/**
 * Running Docker containers, read with `docker ps --format '{{json .}}'`.
 * A missing binary, an unreachable daemon, a non-zero exit or a timeout all
 * mean "no containers", never an error.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

const DOCKER_PS_TIMEOUT = Duration.seconds(3);
const COMPOSE_WORKING_DIR_LABEL = "com.docker.compose.project.working_dir";
const COMPOSE_SERVICE_LABEL = "com.docker.compose.service";

export interface DockerContainer {
  readonly id: string;
  readonly name: string;
  /** The compose service label, when compose started it. */
  readonly service: string | null;
  /** The compose project's working directory label, when compose started it. */
  readonly workingDir: string | null;
  /** Host TCP ports the container publishes, in `docker ps` order. */
  readonly publishedPorts: ReadonlyArray<number>;
}

const DockerPsRow = Schema.Struct({
  ID: Schema.String,
  Names: Schema.String,
  Labels: Schema.optional(Schema.String),
  Ports: Schema.optional(Schema.String),
});
const decodeDockerPsRow = Schema.decodeUnknownOption(Schema.fromJsonString(DockerPsRow));

/** `k=v,k=v` labels; a value keeps any `=` it contains. */
export const parseDockerLabels = (raw: string): ReadonlyMap<string, string> => {
  const labels = new Map<string, string>();
  for (const pair of raw.split(",")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    labels.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  return labels;
};

/** Host TCP ports from `0.0.0.0:5432->5432/tcp, :::5432->5432/tcp`; unpublished ports are skipped. */
export const parseDockerPorts = (raw: string): ReadonlyArray<number> => {
  const ports = new Set<number>();
  for (const mapping of raw.split(",")) {
    const match = /:(\d+)(?:-\d+)?->\d+(?:-\d+)?\/tcp$/.exec(mapping.trim());
    const port = match ? Number.parseInt(match[1] ?? "", 10) : Number.NaN;
    if (Number.isInteger(port) && port > 0 && port < 65536) ports.add(port);
  }
  return [...ports];
};

/** One container per JSON line; lines that do not decode are skipped. */
export const parseDockerPs = (raw: string): ReadonlyArray<DockerContainer> =>
  raw.split("\n").flatMap((line) => {
    if (line.trim().length === 0) return [];
    const row = decodeDockerPsRow(line);
    if (Option.isNone(row)) return [];
    const labels = parseDockerLabels(row.value.Labels ?? "");
    return [
      {
        id: row.value.ID,
        name: row.value.Names.split(",", 1)[0] ?? row.value.Names,
        service: labels.get(COMPOSE_SERVICE_LABEL) || null,
        workingDir: labels.get(COMPOSE_WORKING_DIR_LABEL) || null,
        publishedPorts: parseDockerPorts(row.value.Ports ?? ""),
      },
    ];
  });

export class DockerScanner extends Context.Service<
  DockerScanner,
  {
    /** Running containers; empty when Docker is missing or unreachable. */
    readonly listContainers: Effect.Effect<ReadonlyArray<DockerContainer>>;
  }
>()("t3/threadGroups/DockerScanner") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;

  const listContainers = processRunner
    .run({
      command: "docker",
      args: ["ps", "--format", "{{json .}}"],
      timeout: DOCKER_PS_TIMEOUT,
      maxOutputBytes: 1024 * 1024,
    })
    .pipe(
      Effect.map((result) => (result.code === 0 ? parseDockerPs(result.stdout) : [])),
      Effect.catchCause((cause) =>
        Effect.logDebug("docker container scan failed", { cause }).pipe(Effect.as([])),
      ),
      Effect.withSpan("DockerScanner.listContainers"),
    );

  return DockerScanner.of({ listContainers });
});

export const layer = Layer.effect(DockerScanner, make);
