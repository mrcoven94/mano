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
  // The Standard model ID that answers real texts, set in wrangler.toml.
  MANO_REPLY_MODEL?: string;
  CF_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
  AI_GATEWAY_PROVIDER?: string;
  MANO_TEXT_DAILY_BUDGET_USD?: string;
  MANO_TEXT_USD_PER_1K_CHARS?: string;
  TURN_BATCH_MS?: string;
  TURN_INTERIM_MS?: string;
  BLOOIO_MEDIA_HOSTS?: string;
  // How long a turn runs before the eyes go on the person's message.
  TURN_EYES_AFTER_MS?: string;
  // Mano's chat background image (an https URL we host), set once per
  // chat, only when MANO_CHAT_BACKGROUND_ENABLED is "true".
  MANO_CHAT_BACKGROUND_URL?: string;
  MANO_CHAT_BACKGROUND_ENABLED?: string;
  // "false" turns off every reaction and the eyes.
  MANO_REACTIONS_ENABLED?: string;
  // Our line's own number or alias, checked against the channel_address
  // on inbound webhooks when both are present. Public value; optional.
  MANO_TEXT_NUMBER?: string;
  // Mano's agent: answers turns when set, with the plain responder as
  // fallback. The secret signs both directions of agent traffic.
  // Provider API base URL override, for a local stand-in of the provider
  // in end-to-end runs. Unset in production.
  BLOOIO_BASE_URL?: string;
  AGENT_URL?: string;
  MANO_AGENT_SECRET?: string;
  // Signs the per-turn handle grant the agent forwards to the engine, so
  // the agent can act for the handle that just texted and no one else.
  // The engine holds the same secret; the agent never does.
  MANO_HANDLE_GRANT_SECRET?: string;
  // Engine, for removing a deleted conversation's agent state. Channels'
  // own Engine token opens only that route.
  MANO_ENGINE_URL?: string;
  // "1" opens POST /dev/delete for local end-to-end runs. Never set in a
  // deployment.
  MANO_DEV_ROUTES?: string;
  // Verifies Engine's reminder deliveries on /internal/agent-send only.
  MANO_ENGINE_SEND_SECRET?: string;
  MANO_ENGINE_CHANNELS_TOKEN?: string;
}

export function numberEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return value !== undefined && Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
