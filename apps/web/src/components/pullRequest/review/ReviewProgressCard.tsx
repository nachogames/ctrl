import type {
  ReviewGateTone,
  ReviewProgress,
  ReviewProgressRound,
} from "@t3tools/client-runtime/state/review-sessions";

import { cn } from "~/lib/utils";

const TONE_DOT: Record<ReviewGateTone, string> = {
  done: "bg-success",
  waiting: "bg-warning",
  blocked: "bg-destructive",
  neutral: "bg-muted-foreground/60",
};

/** Where the pull request stands against its goal: approval when reviewing, merge when yours. */
export function ReviewProgressCard({ progress }: { progress: ReviewProgress }) {
  return (
    <section
      aria-label="Review progress"
      className="flex flex-col gap-3 rounded-xl border border-border/70 bg-background p-3 shadow-sm"
    >
      <div>
        <p className="text-2xs font-medium tracking-wider text-muted-foreground uppercase">
          Your goal · {progress.goal}
        </p>
        <h3 className="text-base font-semibold">{progress.headline}</h3>
        <p className="text-xs text-muted-foreground">{progress.detail}</p>
      </div>
      <ul className="grid grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-2">
        {progress.gates.map((gate) => (
          <li key={gate.label} className="rounded-lg border border-border/60 px-2.5 py-1.5">
            <p className="text-2xs text-muted-foreground">{gate.label}</p>
            <p className="flex items-center gap-1.5 text-xs font-medium">
              <span aria-hidden="true" className={cn("size-2 rounded-full", TONE_DOT[gate.tone])} />
              {gate.value}
            </p>
          </li>
        ))}
      </ul>
      {progress.rounds.length === 0 ? null : (
        <RoundBars rounds={progress.rounds} trend={progress.trend} />
      )}
    </section>
  );
}

const CHART_HEIGHT = 56;

/** Issues each reviewed commit raised first: green once resolved, amber while still open. */
function RoundBars({
  rounds,
  trend,
}: {
  rounds: ReadonlyArray<ReviewProgressRound>;
  trend: string | null;
}) {
  // A floor keeps one or two issues from drawing a full-height bar.
  const peak = Math.max(5, ...rounds.map((round) => round.found));
  return (
    <div className="flex flex-col gap-1">
      <p className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium">Issues found each round</span>
        <span className="flex gap-2.5 text-2xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <span aria-hidden="true" className="size-2 rounded-sm bg-success" />
            resolved
          </span>
          <span className="flex items-center gap-1">
            <span aria-hidden="true" className="size-2 rounded-sm bg-warning" />
            open
          </span>
        </span>
      </p>
      <ol
        className="flex items-end gap-1 overflow-x-auto pt-1"
        style={{ height: CHART_HEIGHT + 44 }}
        aria-label="Issues found per round"
      >
        {rounds.map((round) => {
          const resolved = round.found - round.open;
          const unit = CHART_HEIGHT / peak;
          return (
            <li
              key={round.number}
              className="flex w-9 shrink-0 flex-col items-center justify-end gap-0.5"
              aria-label={`Round ${round.number} · ${round.commitSha?.slice(0, 7) ?? ""}: ${round.found} found, ${round.open} open`}
            >
              <span className="text-2xs tabular-nums">{round.found}</span>
              <span className="flex w-6 flex-col overflow-hidden rounded-sm">
                {round.open > 0 ? (
                  <span className="bg-warning" style={{ height: round.open * unit }} />
                ) : null}
                {resolved > 0 ? (
                  <span className="bg-success" style={{ height: resolved * unit }} />
                ) : null}
                {round.found === 0 ? <span className="h-px bg-border" /> : null}
              </span>
              <span className="text-2xs text-muted-foreground">R{round.number}</span>
            </li>
          );
        })}
      </ol>
      {trend === null ? null : <p className="text-xs text-muted-foreground">{trend}</p>}
    </div>
  );
}
