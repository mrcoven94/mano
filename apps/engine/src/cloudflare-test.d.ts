declare module "cloudflare:test" {
  export const env: Record<string, unknown> & {
    PERSON_AGENT: DurableObjectNamespace;
    ORG_AGENT: DurableObjectNamespace;
  };
  export const SELF: { fetch: typeof fetch };
  export function runInDurableObject<R>(
    stub: DurableObjectStub,
    callback: (instance: unknown, state: DurableObjectState) => R | Promise<R>,
  ): Promise<R>;
}
