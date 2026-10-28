import { handleRequest, type PortalConfig } from "./app";
import { PortalStore } from "./durable";
import { R2FileStore } from "./files";

export { PortalStore };

export interface Env {
  PORTAL_STORE: DurableObjectNamespace<PortalStore>;
  FILES: R2Bucket;
  SANDBOX_PORTAL_TOKEN?: string;
  SESSION_TIMEOUT_MINUTES?: string;
  SLOW_MS_DEFAULT?: string;
  MAX_UPLOAD_BYTES?: string;
  MAX_UPLOAD_FILES?: string;
  MAX_BODY_BYTES?: string;
  MAX_FIELD_LENGTH?: string;
  RATE_LIMIT_PER_MINUTE?: string;
  SLOW_MAX_CONCURRENT?: string;
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function configFromEnv(env: Env): PortalConfig {
  return {
    sessionTimeoutMinutes: num(env.SESSION_TIMEOUT_MINUTES, 15),
    slowMsDefault: num(env.SLOW_MS_DEFAULT, 20000),
    maxUploadBytes: num(env.MAX_UPLOAD_BYTES, 5 * 1024 * 1024),
    maxUploadFiles: num(env.MAX_UPLOAD_FILES, 3),
    maxBodyBytes: num(env.MAX_BODY_BYTES, 24 * 1024 * 1024),
    maxFieldLength: num(env.MAX_FIELD_LENGTH, 500),
    rateLimitPerMinute: num(env.RATE_LIMIT_PER_MINUTE, 60),
    slowMaxConcurrent: num(env.SLOW_MAX_CONCURRENT, 5),
    ...(env.SANDBOX_PORTAL_TOKEN ? { portalToken: env.SANDBOX_PORTAL_TOKEN } : {}),
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const stub = env.PORTAL_STORE.get(env.PORTAL_STORE.idFromName("portal"));
    return handleRequest(request, stub, new R2FileStore(env.FILES), configFromEnv(env));
  },
};
