// Worker environment. Secrets arrive through wrangler secret /
// dashboard values; nothing account-specific is hard-coded.
export interface Env {
  CONVERSATION: DurableObjectNamespace;
  CHANNEL_STATE: DurableObjectNamespace;
  EVENTS: Queue<unknown>;
  FILES: R2Bucket;
  BLOOIO_API_KEY: string;
  BLOOIO_CHANNEL_ID: string;
  BLOOIO_WEBHOOK_SECRET: string;
  MANO_HANDLE_PEPPER: string;
  ENCRYPTION_KEK_B64: string;
  META_MODEL_API_KEY?: string;
  CF_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
  AI_GATEWAY_PROVIDER?: string;
  MANO_TEXT_DAILY_BUDGET_USD?: string;
  MANO_TEXT_USD_PER_1K_CHARS?: string;
  TURN_BATCH_MS?: string;
  TURN_INTERIM_MS?: string;
  BLOOIO_MEDIA_HOSTS?: string;
}

export function numberEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return value !== undefined && Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
