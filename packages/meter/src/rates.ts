// The one rates table for model cost estimates. Every estimated cost
// in every meter record comes from here. Rates are estimates per 1,000
// tokens, in USD; they are checked against the provider price sheet and
// updated in this file only. Deploys can override them through
// RateOverrides without editing code. Stand-ins and fakes cost nothing.
export interface ModelRate {
  inputPer1kUsd: number;
  outputPer1kUsd: number;
}

export const MODEL_RATES: Record<string, ModelRate> = {
  "muse-spark-1.3": { inputPer1kUsd: 0.0015, outputPer1kUsd: 0.006 },
  "muse-spark": { inputPer1kUsd: 0.0015, outputPer1kUsd: 0.006 },
  "muse-wonder": { inputPer1kUsd: 0.003, outputPer1kUsd: 0.012 },
  "stand-in": { inputPer1kUsd: 0, outputPer1kUsd: 0 },
  fake: { inputPer1kUsd: 0, outputPer1kUsd: 0 },
  recorded: { inputPer1kUsd: 0, outputPer1kUsd: 0 },
};

// Unknown model IDs estimate at zero rather than guessing a price. Add
// the real rate here once the model is known.
export const FALLBACK_RATE: ModelRate = { inputPer1kUsd: 0, outputPer1kUsd: 0 };

export type RateOverrides = Record<string, ModelRate>;

export function rateFor(model: string, overrides: RateOverrides = {}): ModelRate {
  return overrides[model] ?? MODEL_RATES[model] ?? FALLBACK_RATE;
}

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number, overrides: RateOverrides = {}): number {
  const rate = rateFor(model, overrides);
  const cost = (inputTokens / 1000) * rate.inputPer1kUsd + (outputTokens / 1000) * rate.outputPer1kUsd;
  return Math.round(cost * 1e8) / 1e8;
}
