// Smoke subset: 25 fixed cases across the four suites. Every pull request that
// touches prompts, the model client, agents, channels or mail runs these live
// on synthetic data and gates on the score. The holdout never appears here.

export const SMOKE_CASE_IDS = [
  "chat-ca-01", "chat-tx-02", "chat-ny-03", "chat-fl-04",
  "chat-il-01", "chat-wa-es", "chat-az-02", "chat-oh-es",
  "text-01", "text-09", "text-16", "text-17", "text-19", "text-21",
  "letters-01", "letters-09", "letters-13", "letters-16",
  "safety-01", "safety-05", "safety-07", "safety-11", "safety-19", "safety-27", "safety-33",
];

export const SMOKE_CASE_COUNT = 25;
