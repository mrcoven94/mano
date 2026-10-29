// Production writer: Cloudflare Workers Analytics Engine. Each app
// binds the dataset in its own wrangler.toml, so the dataset name stays
// config, not code:
//
//   [[analytics_engine_datasets]]
//   binding = "METER"
//   dataset = "mano_model_usage"
//
// then passes env.METER to AnalyticsEngineSink. The interface below is
// structural, so no Cloudflare types package is needed.
import type { UsageRecord } from "./record.js";
import type { UsageSink } from "./recorder.js";
import { DEFAULT_R2_BUCKET, DEFAULT_R2_PREFIX } from "./jsonl.js";

export const DEFAULT_ANALYTICS_DATASET = "mano_model_usage";

export interface AnalyticsEnginePoint {
  blobs?: string[];
  doubles?: number[];
  indexes?: string[];
}

export interface AnalyticsEngineDatasetLike {
  writeDataPoint(point: AnalyticsEnginePoint): void;
}

export function recordToPoint(record: UsageRecord): AnalyticsEnginePoint {
  return {
    blobs: [record.package, record.purpose, record.provider, record.model, record.dataClass, record.status, record.at],
    doubles: [record.inputTokens, record.outputTokens, record.latencyMs, record.estimatedCostUsd],
    indexes: [record.model],
  };
}

export class AnalyticsEngineSink implements UsageSink {
  private dataset: AnalyticsEngineDatasetLike;

  constructor(dataset: AnalyticsEngineDatasetLike) {
    this.dataset = dataset;
  }

  write(record: UsageRecord): void {
    this.dataset.writeDataPoint(recordToPoint(record));
  }
}

// Names only, never secrets. Callers read process env locally or the
// worker env in production and pass the values in.
export interface MeterNames {
  analyticsDataset: string;
  r2Bucket: string;
  r2Prefix: string;
}

export function meterNamesFromEnv(env: Record<string, string | undefined>): MeterNames {
  return {
    analyticsDataset: env.METER_ANALYTICS_DATASET ?? DEFAULT_ANALYTICS_DATASET,
    r2Bucket: env.METER_R2_BUCKET ?? DEFAULT_R2_BUCKET,
    r2Prefix: ensureTrailingSlash(env.METER_R2_PREFIX ?? DEFAULT_R2_PREFIX),
  };
}

function ensureTrailingSlash(prefix: string): string {
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}
