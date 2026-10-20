import { useAtomValue } from "@effect/atom-react";
import { createSpeechEnvironmentAtoms } from "@t3tools/client-runtime/state/speech";
import type { EnvironmentId, SpeechState } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

export const speechEnvironment = createSpeechEnvironmentAtoms(connectionAtomRuntime);

/** The latest speech state for one environment, kept while the subscription reconnects. */
const lastSpeechStateAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): SpeechState | null => {
    const current = AsyncResult.value(get(speechEnvironment.state({ environmentId, input: {} })));
    return Option.isSome(current)
      ? current.value
      : Option.getOrNull(get.self<SpeechState | null>());
  }).pipe(Atom.withLabel(`speech:last-state:${environmentId}`)),
);

const NO_SPEECH_STATE = Atom.make<SpeechState | null>(null);

/** Speech state for one environment; null until it first loads or when the server lacks speech. */
export function useSpeechState(environmentId: EnvironmentId | null) {
  const query = useEnvironmentQuery(
    environmentId === null ? null : speechEnvironment.state({ environmentId, input: {} }),
  );
  const state = useAtomValue(
    environmentId === null ? NO_SPEECH_STATE : lastSpeechStateAtom(environmentId),
  );
  return { state, error: query.error };
}
