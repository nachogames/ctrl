import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_HOME_SETTINGS,
  type EnvironmentId,
  type HomeSettings,
  type HomeWatchEvent,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { isElectron } from "../../env";
import { useThreadShells } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { homeEnvironment, liveShellEnvironmentIdsAtom } from "../../state/home";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { diffWatchedThreads, homeWatchKey, type WatchedThreadState } from "./homeWatch";

/** How long watched events gather before Home is woken with all of them. */
const WATCH_REPORT_DELAY_MS = 1_500;
/** A failed report is retried this often, for about a minute, then dropped. */
const WATCH_REPORT_RETRY_MS = 5_000;
const WATCH_REPORT_ATTEMPTS = 12;

/**
 * Desktop-only host for Home. While Home is on, this renderer reports watched
 * thread changes in every environment it is connected to, and keeps itself
 * alive when the window closes.
 */
export function HomeFleetHost() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  if (!isElectron || primaryEnvironmentId === null) return null;
  return <HomeHub environmentId={primaryEnvironmentId} />;
}

function HomeHub({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const home = settings?.home ?? DEFAULT_HOME_SETTINGS;
  const on = home.threadId !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- sets the desktop bridge's keep-alive-on-close while Home is on
  useEffect(() => {
    void window.desktopBridge?.setKeepAliveOnClose?.(on);
    // With Home off, closing the window should quit as usual.
    return () => void window.desktopBridge?.setKeepAliveOnClose?.(false);
  }, [on]);
  if (!on) return null;
  return <HomeWatchReporter environmentId={environmentId} home={home} />;
}

function HomeWatchReporter({
  environmentId,
  home,
}: {
  readonly environmentId: EnvironmentId;
  readonly home: HomeSettings;
}) {
  const shells = useThreadShells();
  const liveEnvironmentIds = useAtomValue(liveShellEnvironmentIdsAtom);
  const { environments } = useEnvironments();
  // Watches that exist when the reporter starts only set a baseline.
  const [knownWatchKeys] = useState(
    () => new Set(home.watches.map((watch) => homeWatchKey(watch.environmentId, watch.threadId))),
  );
  const labels = new Map(
    environments.map((environment) => [environment.environmentId, environment.label]),
  );
  const report = useAtomCommand(homeEnvironment.reportWatchEvents, { reportFailure: false });
  const previous = useRef<ReadonlyMap<string, WatchedThreadState>>(new Map());
  const pending = useRef<Array<HomeWatchEvent>>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failures = useRef(0);
  const sending = useRef(false);
  const stopped = useRef(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- batches watch transitions into timed reports to the server
  useEffect(() => {
    const { next, events } = diffWatchedThreads({
      previous: previous.current,
      shells,
      home,
      knownWatchKeys,
      liveEnvironmentIds,
      labelFor: (id) => labels.get(id),
    });
    previous.current = next;
    pending.current.push(...events);
    // Queued events also restart here after an effect replay cleared the timer.
    if (pending.current.length === 0 || timer.current !== null || sending.current) return;
    // One batch is in flight at a time, and a failed one goes back to the
    // front. A later batch that ends a watch must not land before an earlier
    // batch about the same thread.
    const send = async () => {
      timer.current = null;
      sending.current = true;
      const batch = pending.current;
      pending.current = [];
      const result = await report({ environmentId, input: { events: batch } });
      sending.current = false;
      if (stopped.current) return;
      if (result._tag !== "Success" && ++failures.current < WATCH_REPORT_ATTEMPTS) {
        pending.current = [...batch, ...pending.current];
        timer.current = setTimeout(() => void send(), WATCH_REPORT_RETRY_MS);
        return;
      }
      failures.current = 0;
      if (pending.current.length > 0) {
        timer.current = setTimeout(() => void send(), WATCH_REPORT_DELAY_MS);
      }
    };
    timer.current = setTimeout(() => void send(), WATCH_REPORT_DELAY_MS);
  }, [environmentId, home, knownWatchKeys, labels, liveEnvironmentIds, report, shells]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the report timer and drops late results on unmount
  useEffect(() => {
    stopped.current = false;
    return () => {
      stopped.current = true;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, []);
  return null;
}
