import type { GeminiLiveModel } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * Paid-tier Gemini Live prices in USD per million tokens, from
 * https://ai.google.dev/gemini-api/docs/pricing (read 2026-10-20). Both
 * models share one table there. Update here when Google changes them.
 */
const LIVE_PRICES = {
  input: { TEXT: 0.75, AUDIO: 3.0, IMAGE: 1.0, VIDEO: 1.0 },
  output: { TEXT: 4.5, AUDIO: 12.0 },
} as const;

export const GEMINI_LIVE_PRICES_PER_MILLION: Record<GeminiLiveModel, typeof LIVE_PRICES> = {
  "gemini-3.1-flash-live-preview": LIVE_PRICES,
  "gemini-3.8-live": LIVE_PRICES,
};

interface ModalityCount {
  readonly modality?: string;
  readonly tokenCount?: number;
}

/** The fields of Gemini's `usageMetadata` that are billed. */
export interface LiveUsage {
  readonly promptTokenCount?: number;
  readonly responseTokenCount?: number;
  readonly thoughtsTokenCount?: number;
  readonly toolUsePromptTokenCount?: number;
  readonly promptTokensDetails?: ReadonlyArray<ModalityCount>;
  readonly responseTokensDetails?: ReadonlyArray<ModalityCount>;
  readonly toolUsePromptTokensDetails?: ReadonlyArray<ModalityCount>;
}

const count = (value: number | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/**
 * Tokens priced by modality. Tokens a total reports but the details do not
 * place are priced at `fallback`, the side's dearest rate, so a report Ctrl
 * cannot read in full still errs toward the cap.
 */
function side(
  total: number | undefined,
  details: ReadonlyArray<ModalityCount> | undefined,
  prices: Readonly<Record<string, number>>,
  fallback: number,
): number {
  let placed = 0;
  let usd = 0;
  for (const detail of details ?? []) {
    const tokens = count(detail.tokenCount);
    placed += tokens;
    usd += tokens * (prices[detail.modality ?? ""] ?? fallback);
  }
  return usd + Math.max(0, count(total) - placed) * fallback;
}

/** What one `usageMetadata` report costs, in USD. */
export function liveUsageCostUsd(model: GeminiLiveModel, usage: LiveUsage): number {
  const prices = GEMINI_LIVE_PRICES_PER_MILLION[model];
  const input =
    side(usage.promptTokenCount, usage.promptTokensDetails, prices.input, prices.input.AUDIO) +
    side(
      usage.toolUsePromptTokenCount,
      usage.toolUsePromptTokensDetails,
      prices.input,
      prices.input.AUDIO,
    );
  // Thinking is billed as text output.
  const output =
    side(
      usage.responseTokenCount,
      usage.responseTokensDetails,
      prices.output,
      prices.output.AUDIO,
    ) +
    count(usage.thoughtsTokenCount) * prices.output.TEXT;
  return (input + output) / 1_000_000;
}

/** The calendar month spend is counted in, in UTC: "2026-10". */
export function spendMonth(nowMs: number): string {
  return DateTime.formatIsoDateUtc(DateTime.makeUnsafe(nowMs)).slice(0, 7);
}
