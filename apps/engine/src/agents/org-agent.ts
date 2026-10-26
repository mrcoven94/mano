import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.js";

export interface SharedCase {
  caseId: string;
  personId: string;
  purpose: string;
  sharedAt: string;
}

export class OrgAgent extends DurableObject<Env> {
  orgId = "";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS cases(case_id TEXT PRIMARY KEY, person_id TEXT NOT NULL, purpose TEXT NOT NULL, shared_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT, detail TEXT, created_at TEXT)`);
      const stored = await ctx.storage.get<string>("orgId");
      if (stored) this.orgId = stored;
    });
  }

  async setIdentity(orgId: string) {
    this.orgId = orgId;
    await this.ctx.storage.put("orgId", orgId);
  }

  async shareCase(c: SharedCase) {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO cases VALUES (?,?,?,?,0)",
      c.caseId, c.personId, c.purpose, c.sharedAt,
    );
    return c;
  }

  async revokeCase(caseId: string) {
    this.ctx.storage.sql.exec("UPDATE cases SET revoked = 1 WHERE case_id = ?", caseId);
  }

  async listCases(): Promise<SharedCase[]> {
    const rows = [...this.ctx.storage.sql.exec("SELECT * FROM cases WHERE revoked = 0").toArray()] as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      caseId: r.case_id as string,
      personId: r.person_id as string,
      purpose: r.purpose as string,
      sharedAt: r.shared_at as string,
    }));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.endsWith("/cases")) {
      return Response.json({ cases: await this.listCases() });
    }
    if (request.method === "POST" && url.pathname.endsWith("/share")) {
      const body = (await request.json()) as SharedCase;
      return Response.json(await this.shareCase(body));
    }
    return new Response("Not found", { status: 404 });
  }
}
