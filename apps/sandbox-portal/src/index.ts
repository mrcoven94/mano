/**
 * Sandbox portal: a fake state benefits portal that every Mano demo submits
 * to. Mano never touches a real benefits site; it practices here.
 *
 * What it does: a three-step renewal application (household info, document
 * uploads, review and submit) with a session timeout, confirmation numbers,
 * and a deliberately old-looking design. Every submission carries an
 * idempotency key scoped to the caller; GET /submissions/:key reports
 * received (with the packet digest) or not_found, so the action gateway
 * reconciles after a timeout instead of submitting twice. Slow mode stores
 * first, then holds the response past the caller's timeout. /caseworker
 * lists submissions for staff. Every page is labeled as a test system.
 *
 * Run it: pnpm install, then pnpm --filter @mano/sandbox-portal dev.
 * Copy .env.example to .dev.vars to change timeouts and limits. The
 * caseworker view and JSON API need SANDBOX_PORTAL_TOKEN (wrangler secret
 * put); without it they stay off. Local dev uses local Durable Object and
 * R2 storage; create the bucket with: wrangler r2 bucket create
 * mano-sandbox-portal-files.
 *
 * Test it: pnpm --filter @mano/sandbox-portal check (tsc plus vitest
 * against in-memory stores; no Cloudflare account needed).
 *
 * Deploy it: pushing to main deploys through the GitHub Action. The action
 * needs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and SANDBOX_PORTAL_TOKEN.
 */
import { handleRequest, runCleanup, type PortalConfig } from "./app";
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

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const stub = env.PORTAL_STORE.get(env.PORTAL_STORE.idFromName("portal"));
    ctx.waitUntil(runCleanup(stub, new R2FileStore(env.FILES), Date.now()));
  },
};
