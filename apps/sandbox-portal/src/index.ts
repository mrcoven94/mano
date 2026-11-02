/**
 * Sandbox portal: a fake state benefits portal that every Mano demo files
 * to. Mano never touches a real benefits site; it practices here.
 *
 * What it does: a three-step renewal application (household info, document
 * uploads, review) with a session timeout and a deliberately old-looking
 * design. The browser never files: its Submit saves a draft. The caller opens
 * /apply?draft=<id> with its own id (32 to 128 lowercase hex characters);
 * saving the household step and pressing Submit write that draft, and
 * GET /drafts/<id> returns { id, household, savedAt } so the agent can compare
 * every field with what the person approves. Only the JSON POST /submissions
 * with the filing token creates a submission and a confirmation number. Every
 * submission carries an idempotency key scoped to the caller; GET
 * /submissions/:key reports received (with the packet digest) or not_found,
 * so the action gateway reconciles after a timeout instead of filing twice.
 * Slow mode stores first, then holds the response past the caller's timeout.
 * /caseworker lists filed submissions for staff. Every page is labeled as a
 * test system.
 *
 * Tokens: SANDBOX_PORTAL_TOKEN files, reconciles, opens the caseworker view
 * and reads drafts; only the office's filing service holds it. The optional
 * SANDBOX_PORTAL_DRAFT_TOKEN only reads drafts, for the agent on the person's
 * computer. Without a token its routes answer 503.
 *
 * Run it: pnpm install, then pnpm --filter @mano/sandbox-portal dev.
 * Copy .env.example to .dev.vars to change timeouts and limits, and set the
 * tokens with wrangler secret put. Local dev uses local Durable Object and R2
 * storage; create the bucket with: wrangler r2 bucket create
 * mano-sandbox-portal-files.
 *
 * Test it: pnpm --filter @mano/sandbox-portal check (tsc plus vitest
 * against in-memory and SQLite stores; no Cloudflare account needed).
 *
 * Deploy it: pushing to main deploys through the GitHub Action. The action
 * needs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and SANDBOX_PORTAL_TOKEN;
 * SANDBOX_PORTAL_DRAFT_TOKEN is optional and must differ from the filing token.
 */
import { handleRequest, runCleanup, type PortalConfig } from "./app";
import { PortalStore } from "./durable";
import { R2FileStore } from "./files";

export { PortalStore };

export interface Env {
  PORTAL_STORE: DurableObjectNamespace<PortalStore>;
  FILES: R2Bucket;
  SANDBOX_PORTAL_TOKEN?: string;
  SANDBOX_PORTAL_DRAFT_TOKEN?: string;
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
    ...(env.SANDBOX_PORTAL_DRAFT_TOKEN ? { draftToken: env.SANDBOX_PORTAL_DRAFT_TOKEN } : {}),
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
