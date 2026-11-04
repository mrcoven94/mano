export interface Env {
  PERSON_AGENT: DurableObjectNamespace;
  ORG_AGENT: DurableObjectNamespace;
  FILES: R2Bucket;
  META_MODEL_API_KEY: string;
  ENCRYPTION_KEK_B64: string;
  SESSION_SECRET?: string;
  MANO_ENV?: string;
  OPERATOR_SECRET?: string;
  // The agent's service token, and the secret Channels signs handle
  // grants with. Without both, the agent path refuses every request.
  MANO_ENGINE_AGENT_TOKEN?: string;
  MANO_HANDLE_GRANT_SECRET?: string;
  // Channels' own token for the one route it calls here: deleting a
  // person's conversation state. It needs a handle grant too.
  MANO_ENGINE_CHANNELS_TOKEN?: string;
  // Due reminders go out through Channels' agent-send route at this base
  // URL, signed with the Engine-to-Channels secret (never the agent's).
  MANO_CHANNELS_URL?: string;
  MANO_ENGINE_SEND_SECRET?: string;
  // Local time of day deadline nudges go out, "HH:MM" between 09:00 and
  // 20:00. Default 10:00.
  MANO_NUDGE_TIME?: string;
  // "on" lets the daily check text people (src/always-on.ts). Anything else, or
  // unset: it runs and sends nothing.
  MANO_DAILY_CHECK_SENDS?: string;
  // Guardian's check endpoint, its bearer token and the Modal proxy key
  // pair. With none of the four set the gateway runs local rules only.
  MANO_GUARDIAN_URL?: string;
  MANO_GUARDIAN_TOKEN?: string;
  MANO_GUARDIAN_KEY_ID?: string;
  MANO_GUARDIAN_KEY_SECRET?: string;
  CF_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
  AI_GATEWAY_PROVIDER?: string;
  MODEL_ALLOWLIST_EXTRA?: string;
  EXECUTOR_MODE?: string;
  SANDBOX_BASE_URL?: string;
  SANDBOX_PORTAL_TOKEN?: string;
  // The sandbox portal's MAX_FIELD_LENGTH and MAX_UPLOAD_BYTES, set in
  // wrangler.toml [vars]; a test keeps them equal to the portal's.
  SANDBOX_MAX_FIELD_LENGTH?: string;
  SANDBOX_MAX_UPLOAD_BYTES?: string;
}
