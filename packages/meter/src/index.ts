// @mano/meter: one small usage recorder every model client calls
// after each request. A record holds counts and labels only (package,
// purpose, provider, exact model ID, environment, synthetic or real,
// token counts with reasoning split out, latency, status, estimated
// cost from the rates table in ./rates.js) and never prompts, answers,
// person IDs, phone numbers or any other content. Every label is
// allowlisted in ./record.js. Production writes go to the Workers
// Analytics Engine dataset mano_model_usage (bind it in each app's
// wrangler.toml; see ./analytics.js); the nightly workflow exports the
// dataset back to JSON lines in the mano-meter R2 bucket (see
// history/ae-export.mjs), which /stats reads through ./r2.js. CI and
// local runs append JSON lines, one file per UTC day, and upload a
// daily summary to the same bucket (see ./jsonl.js). All names are
// config (meterNamesFromEnv); meter takes no secrets. Use: const meter
// = new MeterRecorder([new AnalyticsEngineSink(env.METER)]); const
// elapsed = startCall(); ... await meter.record({ package: "channels",
// purpose: "answer-texts", provider: "meta", model: "muse-spark-1.3",
// dataClass: "real", environment: "production", inputTokens,
// outputTokens, reasoningTokens, latencyMs: elapsed(), status: "ok" }).
// Run: pnpm --filter @mano/meter check (tsc plus vitest, no keys needed).
export * from "./record.js";
export * from "./rates.js";
export * from "./recorder.js";
export * from "./analytics.js";
export * from "./jsonl.js";
export * from "./stats.js";
export * from "./r2.js";
