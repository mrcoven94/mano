export interface Env {
  PERSON_AGENT: DurableObjectNamespace;
  ORG_AGENT: DurableObjectNamespace;
  FILES: R2Bucket;
  META_MODEL_API_KEY: string;
  ENCRYPTION_KEK_B64: string;
  AI_GATEWAY_BASE?: string;
  SESSION_SECRET?: string;
}
