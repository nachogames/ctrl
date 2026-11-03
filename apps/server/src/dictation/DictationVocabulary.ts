import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";

/** Most custom words passed to a recognizer; more only dilutes the hint. */
const MAX_WORDS = 100;

/**
 * Words this environment's dictation should recognize even when a speech model
 * has never heard them, such as project names like "PayParty".
 */
export class DictationVocabulary extends Context.Service<
  DictationVocabulary,
  { readonly words: Effect.Effect<ReadonlyArray<string>> }
>()("t3/dictation/DictationVocabulary") {}

export const layer = Layer.effect(
  DictationVocabulary,
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    return DictationVocabulary.of({
      words: projects.listShells().pipe(
        Effect.map((shells) =>
          [...new Set(shells.map((shell) => shell.title))].slice(0, MAX_WORDS),
        ),
        // Vocabulary is a hint: dictation works without it.
        Effect.orElseSucceed(() => []),
      ),
    });
  }),
);

export const layerEmpty = Layer.succeed(DictationVocabulary, { words: Effect.succeed([]) });
