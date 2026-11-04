// @mano/web: one Cloudflare Worker that serves the resident app's web
// build (apps/app, built with `expo export`) and the routes it needs:
// email sign-in and chat with Mano's agent. The app's EXPO_PUBLIC_ENGINE_URL
// points here, so the browser only ever talks to its own origin.
//
// Run: build the app (pnpm --filter @mano/app export:web), copy .env.example
// to .dev.vars and fill it in, then pnpm --filter @mano/web dev.
// Test: pnpm --filter @mano/web check.
// Check a deployed copy: node apps/web/scripts/sign-in-check.mjs (see that file).

import { DurableObject } from "cloudflare:workers";

import { handleApi, type StateStub } from "./handler.js";
import { WebStore } from "./store.js";

interface Env {
  ASSETS: Fetcher;
  STATE: DurableObjectNamespace<WebState>;
  EMAIL: { send(message: { to: string; from: { email: string; name: string }; subject: string; text: string }): Promise<unknown> };
  MANO_WEB_FROM?: string;
  MANO_HANDLE_GRANT_SECRET?: string;
  MANO_AGENT_SECRET?: string;
  MANO_HANDLE_PEPPER?: string;
  AGENT_URL?: string;
}

export class WebState extends DurableObject<Env> {
  private store: WebStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new WebStore(ctx.storage.sql);
  }

  allow(...args: Parameters<WebStore["allow"]>) {
    return this.store.allow(...args);
  }
  createChallenge(...args: Parameters<WebStore["createChallenge"]>) {
    return this.store.createChallenge(...args);
  }
  dropChallenge(...args: Parameters<WebStore["dropChallenge"]>) {
    return this.store.dropChallenge(...args);
  }
  spendChallenge(...args: Parameters<WebStore["spendChallenge"]>) {
    return this.store.spendChallenge(...args);
  }
  beginTurn(...args: Parameters<WebStore["beginTurn"]>) {
    return this.store.beginTurn(...args);
  }
  finishTurn(...args: Parameters<WebStore["finishTurn"]>) {
    return this.store.finishTurn(...args);
  }
  failTurn(...args: Parameters<WebStore["failTurn"]>) {
    return this.store.failTurn(...args);
  }
  recordCrisis(...args: Parameters<WebStore["recordCrisis"]>) {
    return this.store.recordCrisis(...args);
  }
  questionToReport(...args: Parameters<WebStore["questionToReport"]>) {
    return this.store.questionToReport(...args);
  }
  settleQuestion(...args: Parameters<WebStore["settleQuestion"]>) {
    return this.store.settleQuestion(...args);
  }
  listMessages() {
    return this.store.listMessages();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    return handleApi(request, {
      ...env,
      stateFor: (name) => env.STATE.get(env.STATE.idFromName(name)) as unknown as StateStub,
      sendEmail: (message) => env.EMAIL.send(message),
    });
  },
} satisfies ExportedHandler<Env>;
