// Engine port: the engine stays the only authority on who a person is
// and what they may do. Accounts calls it to route a text handle to a
// PersonAgent, exchange a WorkOS user for an engine session token, read
// one thread everywhere, and move case data on merge. Until the engine PR
// merges, the stand-in below implements the same shape in memory.

export interface ThreadMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  channel: "text" | "web" | "app";
  createdAt: string;
}

export interface EnginePersonData {
  conversation: ThreadMessage[];
  documents: { id: string; name: string; hash: string }[];
  approvals: { id: string; status: string }[];
  consents: { recipient: string; purpose: string }[];
}

export interface EngineAccountsPort {
  live: boolean;
  // Text first: return the person for a handle, creating one when new.
  createOrRoute(handle: "phone" | "email", value: string): Promise<{ personId: string; created: boolean }>;
  // AuthKit is the front door, the engine session is the key.
  exchangeWorkos(workosUserId: string, email: string | null): Promise<{ personId: string; sessionToken: string }>;
  mintSession(personId: string): Promise<string>;
  revokeSessions(personId: string): Promise<void>;
  getThread(personId: string): Promise<ThreadMessage[]>;
  appendThread(personId: string, message: Omit<ThreadMessage, "id" | "createdAt">): Promise<ThreadMessage>;
  getDataCounts(personId: string): Promise<{
    conversationMessages: number;
    documents: number;
    approvals: number;
    consents: number;
  }>;
  moveData(fromPersonId: string, intoPersonId: string, idempotencyKey?: string): Promise<void>;
  deleteData(personId: string): Promise<void>;
  audit(personId: string, event: string, detail: Record<string, unknown>): Promise<void>;
  activityLog(personId: string): Promise<{ at: string; event: string; detail: Record<string, unknown> }[]>;
}

export class StandInEngineAccounts implements EngineAccountsPort {
  live = false;
  private people = new Map<string, EnginePersonData>();
  private sessions = new Map<string, Set<string>>();
  private auditLog = new Map<string, { at: string; event: string; detail: Record<string, unknown> }[]>();
  private handleToPerson = new Map<string, string>();
  private workosToPerson = new Map<string, string>();
  private seq = 1;
  private now: () => number;

  constructor(now?: () => number) {
    this.now = now ?? Date.now;
  }

  private ensure(personId: string): EnginePersonData {
    let data = this.people.get(personId);
    if (!data) {
      data = { conversation: [], documents: [], approvals: [], consents: [] };
      this.people.set(personId, data);
    }
    return data;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  // Test hook: seed case data to watch it move on merge.
  seedData(personId: string, data: Partial<EnginePersonData>): void {
    const full = this.ensure(personId);
    if (data.conversation) full.conversation = data.conversation;
    if (data.documents) full.documents = data.documents;
    if (data.approvals) full.approvals = data.approvals;
    if (data.consents) full.consents = data.consents;
  }

  async createOrRoute(handle: "phone" | "email", value: string): Promise<{ personId: string; created: boolean }> {
    const key = `${handle}:${value.toLowerCase()}`;
    const existing = this.handleToPerson.get(key);
    if (existing) return { personId: existing, created: false };
    const personId = `person_standin_${this.seq++}`;
    this.handleToPerson.set(key, personId);
    this.ensure(personId);
    return { personId, created: true };
  }

  async exchangeWorkos(workosUserId: string, email: string | null): Promise<{ personId: string; sessionToken: string }> {
    void email;
    let personId = this.workosToPerson.get(workosUserId);
    if (!personId) {
      personId = `person_standin_${this.seq++}`;
      this.workosToPerson.set(workosUserId, personId);
      this.ensure(personId);
    }
    const token = `v1.standin.${personId}.${this.seq++}`;
    let set = this.sessions.get(personId);
    if (!set) {
      set = new Set();
      this.sessions.set(personId, set);
    }
    set.add(token);
    return { personId, sessionToken: token };
  }

  async mintSession(personId: string): Promise<string> {
    const token = `v1.standin.${personId}.${this.seq++}`;
    let set = this.sessions.get(personId);
    if (!set) {
      set = new Set();
      this.sessions.set(personId, set);
    }
    set.add(token);
    return token;
  }

  async revokeSessions(personId: string): Promise<void> {
    this.sessions.set(personId, new Set());
  }

  sessionsFor(personId: string): string[] {
    return [...(this.sessions.get(personId) ?? [])];
  }

  async getThread(personId: string): Promise<ThreadMessage[]> {
    return [...this.ensure(personId).conversation];
  }

  async appendThread(
    personId: string,
    message: Omit<ThreadMessage, "id" | "createdAt">,
  ): Promise<ThreadMessage> {
    const row: ThreadMessage = { ...message, id: `msg_${this.seq++}`, createdAt: this.iso() };
    this.ensure(personId).conversation.push(row);
    return row;
  }

  async getDataCounts(personId: string): Promise<{
    conversationMessages: number;
    documents: number;
    approvals: number;
    consents: number;
  }> {
    const data = this.ensure(personId);
    return {
      conversationMessages: data.conversation.length,
      documents: data.documents.length,
      approvals: data.approvals.length,
      consents: data.consents.length,
    };
  }

  async moveData(fromPersonId: string, intoPersonId: string, idempotencyKey?: string): Promise<void> {
    void idempotencyKey;
    const from = this.ensure(fromPersonId);
    const into = this.ensure(intoPersonId);
    into.conversation.push(...from.conversation);
    into.conversation.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    into.documents.push(...from.documents);
    into.approvals.push(...from.approvals);
    into.consents.push(...from.consents);
    from.conversation = [];
    from.documents = [];
    from.approvals = [];
    from.consents = [];
    for (const [key, pid] of this.handleToPerson) {
      if (pid === fromPersonId) this.handleToPerson.set(key, intoPersonId);
    }
    for (const [key, pid] of this.workosToPerson) {
      if (pid === intoPersonId || pid === fromPersonId) void key;
    }
  }

  async deleteData(personId: string): Promise<void> {
    this.people.delete(personId);
    this.sessions.delete(personId);
    for (const [key, pid] of [...this.handleToPerson]) {
      if (pid === personId) this.handleToPerson.delete(key);
    }
    for (const [key, pid] of [...this.workosToPerson]) {
      if (pid === personId) this.workosToPerson.delete(key);
    }
  }

  async audit(personId: string, event: string, detail: Record<string, unknown>): Promise<void> {
    let list = this.auditLog.get(personId);
    if (!list) {
      list = [];
      this.auditLog.set(personId, list);
    }
    list.push({ at: this.iso(), event, detail });
  }

  async activityLog(personId: string): Promise<{ at: string; event: string; detail: Record<string, unknown> }[]> {
    return [...(this.auditLog.get(personId) ?? [])];
  }
}

// Live engine client. Contract for the engine-side accounts routes, which
// land in a follow-up after the engine PR merges. All routes take a
// server-to-server credential (MANO_ENGINE_SERVICE_KEY) as a Bearer token,
// never a person session. Session tokens returned are engine v1 tokens
// (`v1.<claims>.<sig>`, HMAC-signed, 24h expiry per the engine auth module);
// the site stores them in the session cookie and passes them back as
// Bearer on engine person routes, which verify them.
//
//   POST {base}/api/accounts/route            {handle, value} -> {personId, created}
//   POST {base}/api/accounts/workos/exchange  {workosUserId, email} -> {personId, sessionToken}
//   POST {base}/api/accounts/sessions         {personId} -> {sessionToken}
//   POST {base}/api/accounts/sessions/revoke  {personId} -> {ok}
//   GET  {base}/api/accounts/persons/:id/thread        -> ThreadMessage[]
//   POST {base}/api/accounts/persons/:id/thread        {role, content, channel} -> ThreadMessage
//   GET  {base}/api/accounts/persons/:id/counts        -> {conversationMessages, documents, approvals, consents}
//   POST {base}/api/accounts/move              {fromPersonId, intoPersonId, idempotencyKey?} -> {ok}
//   POST {base}/api/accounts/persons/:id/delete        -> {ok}
//   POST {base}/api/accounts/persons/:id/audit {event, detail} -> {ok}
//   GET  {base}/api/accounts/persons/:id/activity      -> [{at, event, detail}]
export interface HttpEngineAccountsConfig {
  baseUrl: string;
  serviceKey: string;
  fetchFn?: typeof fetch;
}

export class HttpEngineAccounts implements EngineAccountsPort {
  live = true;
  private baseUrl: string;
  private serviceKey: string;
  private fetchFn: typeof fetch;

  constructor(config: HttpEngineAccountsConfig) {
    if (!config.baseUrl || !config.serviceKey) throw new Error("Accounts are not configured.");
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.serviceKey = config.serviceKey;
    this.fetchFn = config.fetchFn ?? fetch;
  }

  private async call<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${this.serviceKey}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error("The accounts service is unavailable. Try again.");
    return (await res.json()) as T;
  }

  async createOrRoute(handle: "phone" | "email", value: string): Promise<{ personId: string; created: boolean }> {
    return this.call("POST", "/api/accounts/route", { handle, value });
  }

  async exchangeWorkos(workosUserId: string, email: string | null): Promise<{ personId: string; sessionToken: string }> {
    return this.call("POST", "/api/accounts/workos/exchange", { workosUserId, email });
  }

  async mintSession(personId: string): Promise<string> {
    const out = await this.call<{ sessionToken: string }>("POST", "/api/accounts/sessions", { personId });
    return out.sessionToken;
  }

  async revokeSessions(personId: string): Promise<void> {
    await this.call("POST", "/api/accounts/sessions/revoke", { personId });
  }

  async getThread(personId: string): Promise<ThreadMessage[]> {
    return this.call("GET", `/api/accounts/persons/${encodeURIComponent(personId)}/thread`);
  }

  async appendThread(personId: string, message: Omit<ThreadMessage, "id" | "createdAt">): Promise<ThreadMessage> {
    return this.call("POST", `/api/accounts/persons/${encodeURIComponent(personId)}/thread`, { ...message });
  }

  async getDataCounts(personId: string): Promise<{
    conversationMessages: number;
    documents: number;
    approvals: number;
    consents: number;
  }> {
    return this.call("GET", `/api/accounts/persons/${encodeURIComponent(personId)}/counts`);
  }

  async moveData(fromPersonId: string, intoPersonId: string, idempotencyKey?: string): Promise<void> {
    await this.call("POST", "/api/accounts/move", { fromPersonId, intoPersonId, idempotencyKey });
  }

  async deleteData(personId: string): Promise<void> {
    await this.call("POST", `/api/accounts/persons/${encodeURIComponent(personId)}/delete`);
  }

  async audit(personId: string, event: string, detail: Record<string, unknown>): Promise<void> {
    await this.call("POST", `/api/accounts/persons/${encodeURIComponent(personId)}/audit`, { event, detail });
  }

  async activityLog(personId: string): Promise<{ at: string; event: string; detail: Record<string, unknown> }[]> {
    return this.call("GET", `/api/accounts/persons/${encodeURIComponent(personId)}/activity`);
  }
}

// Read the expiry out of an engine v1 session token without verifying it.
// The engine verifies the signature on use; the site only uses this to stop
// sending expired tokens. Returns null for stand-in tokens (demo/tests),
// which carry no claims and are only valid outside production.
export function parseSessionExpiry(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "v1" || !parts[1]) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const bin = typeof Buffer !== "undefined" ? Buffer.from(b64, "base64").toString("binary") : atob(b64);
    const claims = JSON.parse(bin) as { exp?: unknown };
    return typeof claims.exp === "number" ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}
