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
  CF_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
  AI_GATEWAY_PROVIDER?: string;
  MODEL_ALLOWLIST_EXTRA?: string;
  EXECUTOR_MODE?: string;
  SANDBOX_BASE_URL?: string;
}
