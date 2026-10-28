declare module "cloudflare:test" {
  export const env: Record<string, unknown> & {
    CONVERSATION: DurableObjectNamespace;
    CHANNEL_STATE: DurableObjectNamespace;
  };
  export const SELF: { fetch: typeof fetch };
}
