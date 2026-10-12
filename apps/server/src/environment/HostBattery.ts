import type { HostBattery } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as ProcessRunner from "../processRunner.ts";

/**
 * The machine's battery, so other devices can see whether it is about to die.
 * Read with tools any user may run (`pmset` on macOS, sysfs on Linux), so it
 * needs no permission. Machines without a battery, and Windows, report null.
 */
export class HostBatteryService extends Context.Service<
  HostBatteryService,
  {
    readonly current: Effect.Effect<HostBattery | null>;
    /** The current reading followed by every change. */
    readonly streamChanges: Stream.Stream<HostBattery | null>;
  }
>()("t3/environment/HostBattery/HostBatteryService") {}

const POLL_INTERVAL = Duration.minutes(1);
const LINUX_POWER_SUPPLY_ROOT = "/sys/class/power_supply";

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * `pmset -g batt` prints the power source, then one line per battery:
 *   Now drawing from 'AC Power'
 *    -InternalBattery-0 (id=1234)	85%; charging; 1:20 remaining present: true
 */
export function parsePmsetBattery(output: string): HostBattery | null {
  const percent = output.match(/InternalBattery[^\n]*?(\d{1,3})%/)?.[1];
  if (percent === undefined) return null;
  return {
    percent: clampPercent(Number(percent)),
    pluggedIn: output.includes("'AC Power'"),
  };
}

/** sysfs `status` is Charging, Discharging, Full, or Not charging. */
export function parseLinuxBattery(input: {
  readonly capacity: string;
  readonly status: string;
}): HostBattery | null {
  const percent = Number.parseInt(input.capacity.trim(), 10);
  if (!Number.isFinite(percent)) return null;
  return {
    percent: clampPercent(percent),
    pluggedIn: input.status.trim().toLowerCase() !== "discharging",
  };
}

const readDarwinBattery = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const result = yield* processRunner.run({
    command: "pmset",
    args: ["-g", "batt"],
    timeout: "5 seconds",
    timeoutBehavior: "timedOutResult",
  });
  return result.code === 0 ? parsePmsetBattery(result.stdout) : null;
});

const readLinuxBattery = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const supplies = yield* fs.readDirectory(LINUX_POWER_SUPPLY_ROOT);
  const battery = supplies.toSorted().find((name) => name.startsWith("BAT"));
  if (battery === undefined) return null;
  const root = `${LINUX_POWER_SUPPLY_ROOT}/${battery}`;
  return parseLinuxBattery({
    capacity: yield* fs.readFileString(`${root}/capacity`),
    status: yield* fs.readFileString(`${root}/status`),
  });
});

const readBattery = Effect.gen(function* () {
  switch (process.platform) {
    case "darwin":
      return yield* readDarwinBattery.pipe(Effect.orElseSucceed(() => null));
    case "linux":
      return yield* readLinuxBattery.pipe(Effect.orElseSucceed(() => null));
    default:
      return null;
  }
});

function sameBattery(left: HostBattery | null, right: HostBattery | null): boolean {
  return left?.percent === right?.percent && left?.pluggedIn === right?.pluggedIn;
}

export const make = Effect.gen(function* () {
  const services = yield* Effect.context<ProcessRunner.ProcessRunner | FileSystem.FileSystem>();
  const read = readBattery.pipe(Effect.provideContext(services));
  const initial = yield* read;
  const latest = yield* Ref.make(initial);
  const changes = yield* PubSub.sliding<HostBattery | null>(1);

  // A machine with no battery at startup will not grow one, so it never polls.
  if (initial !== null) {
    yield* read.pipe(
      Effect.flatMap((next) =>
        Ref.modify(latest, (previous) => [!sameBattery(previous, next), next] as const).pipe(
          Effect.flatMap((changed) => (changed ? PubSub.publish(changes, next) : Effect.void)),
        ),
      ),
      Effect.repeat(Schedule.spaced(POLL_INTERVAL)),
      Effect.delay(POLL_INTERVAL),
      Effect.forkScoped,
    );
  }

  return HostBatteryService.of({
    current: Ref.get(latest),
    streamChanges: Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before reading so a change landing in between is not lost.
        const subscription = yield* PubSub.subscribe(changes);
        const current = yield* Ref.get(latest);
        return Stream.concat(Stream.make(current), Stream.fromSubscription(subscription));
      }),
    ),
  });
});

export const layer = Layer.effect(HostBatteryService, make);
