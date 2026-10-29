// @mano/meter: one small usage recorder every model client calls
// after each request. A record holds counts and labels only (package,
// purpose, provider, exact model ID, synthetic or real, token counts,
// latency, status, estimated cost from the rates table in ./rates.js)
// and never prompts, answers, person IDs, phone numbers or any other
// content. Production writes go to the Workers Analytics Engine dataset
// mano_model_usage (bind it in each app's wrangler.toml; see
// ./analytics.js). CI and local runs append JSON lines, one file per UTC
// day, and upload a daily summary to the mano-meter R2 bucket (see
// ./jsonl.js). All names are config (meterNamesFromEnv); the only knobs
// are METER_ANALYTICS_DATASET, METER_R2_BUCKET and METER_R2_PREFIX, and
// meter takes no secrets. Use: const meter = new MeterRecorder([new
// AnalyticsEngineSink(env.METER)]); const elapsed = startCall(); ...
// await meter.record({ package: "channels", purpose: "answer-texts",
// provider: "meta", model: "muse-spark-1.3", dataClass: "real",
// inputTokens, outputTokens, latencyMs: elapsed(), status: "ok" }).
// Run: pnpm --filter @mano/meter check (tsc plus vitest, no keys needed).
export * from "./record.js";
export * from "./rates.js";
export * from "./recorder.js";
export * from "./analytics.js";
export * from "./jsonl.js";
export * from "./stats.js";
