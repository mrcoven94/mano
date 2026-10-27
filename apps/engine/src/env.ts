export interface Env {
  PERSON_AGENT: DurableObjectNamespace;
  ORG_AGENT: DurableObjectNamespace;
  FILES: R2Bucket;
  META_MODEL_API_KEY: string;
  ENCRYPTION_KEK_B64: string;
  SESSION_SECRET?: string;
  CF_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
  AI_GATEWAY_PROVIDER?: string;
  MODEL_ALLOWLIST_EXTRA?: string;
}
