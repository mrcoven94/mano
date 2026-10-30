declare module "cloudflare:test" {
  export const env: Record<string, unknown> & {
    CONVERSATION: DurableObjectNamespace;
    CHANNEL_STATE: DurableObjectNamespace;
  };
  export const SELF: { fetch: typeof fetch };
  export function runDurableObjectAlarm(stub: DurableObjectStub): Promise<boolean>;
  export function runInDurableObject<T, R>(stub: DurableObjectStub, fn: (instance: T, state: DurableObjectState) => R | Promise<R>): Promise<R>;
}
