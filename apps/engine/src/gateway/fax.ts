import { boundFetch } from "../fetch.js";
import { bytesToBase64 } from "../hash.js";
import type { ActionRequest, CheckOutcome, Executor } from "./types.js";
import { DefiniteFailureError, NotTheSenderError, UnconfirmedSendError } from "./types.js";
import {
  FAX_RECIPIENT,
  PAYLOAD,
  assertAccepted,
  assertAnswered,
  downstreamKey,
  prepareOutgoing,
  providerFetch,
  providerIdentity,
  type ProviderResponse,
  type OutboundPricing,
} from "./outbound.js";

// Faxes a document to our own number through Telnyx. POST /media uploads
// the PDF, POST /faxes sends it. The fax endpoint takes no idempotency key,
// so the key travels in client_state, and GET /faxes filtered to our number
// is the lookup that answers whether it ever sent.
const BASE_URL = "https://api.telnyx.com/v2";
const LABEL = "The fax provider";
const PAGE_SIZE = 250;
// More than this many pages of our own number's faxes is not an answer.
const MAX_LIST_PAGES = 40;

// Which keys may have gone to the provider. A run claims its row in the
// person's SQLite right before the send, and a row means another run is the
// sender. A Durable Object holds outgoing requests until its writes are
// durable, so a restart cannot forget one. Only an answered refusal gives the
// row back. A key with no row never reached POST /faxes, so nothing under it
// can land.
export interface FaxSendLog {
  wasSent(key: string): boolean;
  claim(key: string): boolean;
  release(key: string): void;
}

export function ensureFaxSendTable(sql: SqlStorage): void {
  sql.exec("CREATE TABLE IF NOT EXISTS fax_sends(key TEXT PRIMARY KEY)");
}

export class SqlFaxSendLog implements FaxSendLog {
  constructor(private sql: SqlStorage) {}

  wasSent(key: string): boolean {
    return this.sql.exec("SELECT key FROM fax_sends WHERE key = ?", key).toArray().length > 0;
  }

  claim(key: string): boolean {
    return this.sql.exec("INSERT OR IGNORE INTO fax_sends(key) VALUES (?)", key).rowsWritten > 0;
  }

  release(key: string): void {
    this.sql.exec("DELETE FROM fax_sends WHERE key = ?", key);
  }
}

export interface FaxConfig {
  apiKey: string;
  connectionId: string;
  // The only number a fax may go to, and the number it is sent from.
  ownNumber: string;
  fromNumber: string;
  pricing: OutboundPricing;
  sendLog: FaxSendLog;
  // The attempt's current version, read at the start of a run and again
  // right before the send, so a run whose attempt moved on sends nothing.
  attemptVersion: (idempotencyKey: string) => number | null;
}

export interface FaxClientState {
  key: string;
  personId: string;
}

export class FaxExecutor implements Executor {
  readonly simulated = false;
  readonly provider: string;

  constructor(
    private config: FaxConfig,
    private fetchFn: typeof fetch = boundFetch,
    private timeoutMs = 20000,
  ) {
    this.provider = providerIdentity("telnyx", config.apiKey);
  }

  private get authorization(): string {
    return `Bearer ${this.config.apiKey}`;
  }

  private recipientProblem(req: ActionRequest): string | null {
    if (req.recipient !== FAX_RECIPIENT || req.payload[PAYLOAD.faxTo] !== this.config.ownNumber) {
      return "Mano can only fax its own test line for now.";
    }
    return null;
  }

  async refuse(req: ActionRequest): Promise<string | null> {
    const problem = this.recipientProblem(req);
    if (problem) return problem;
    const outgoing = await prepareOutgoing(req, "fax", this.config.pricing);
    return outgoing.ok ? null : outgoing.problem;
  }

  private async post(path: string, init: RequestInit): Promise<ProviderResponse> {
    const headers = { authorization: this.authorization, ...init.headers };
    const res = await providerFetch(this.fetchFn, `${BASE_URL}${path}`, { ...init, method: "POST", headers }, this.timeoutMs, LABEL);
    assertAccepted(res, LABEL);
    return res;
  }

  async execute(req: ActionRequest): Promise<{ externalId: string; simulated: boolean }> {
    const version = this.config.attemptVersion(req.idempotencyKey);
    assertAnswered(req);
    const problem = this.recipientProblem(req);
    if (problem) throw new DefiniteFailureError(problem);
    const outgoing = await prepareOutgoing(req, "fax", this.config.pricing);
    if (!outgoing.ok) throw new DefiniteFailureError(outgoing.problem);
    const key = await downstreamKey(req.personId, req.idempotencyKey);
    const state: FaxClientState = { key, personId: req.personId };
    // A fresh name each try: a retry's upload never collides with one a
    // failed try left behind.
    const mediaName = `${key}-${crypto.randomUUID()}`;
    const media = new FormData();
    media.set("media", new Blob([outgoing.pdf], { type: "application/pdf" }), "fax.pdf");
    media.set("media_name", mediaName);
    // The upload is the provider's copy of the person's document, and it
    // deletes it at this expiry. The fax itself stores no media of its own:
    // store_media, off by default, cannot be sent with media_name anyway.
    media.set("ttl_secs", "3600");
    await this.post("/media", { body: media });
    // One synchronous step with the send: the attempt is still this run's,
    // and no other run holds the row. The provider has no dedupe, so this is
    // what makes one POST.
    if (this.config.attemptVersion(req.idempotencyKey) !== version || !this.config.sendLog.claim(key)) throw new NotTheSenderError();
    let res: ProviderResponse;
    try {
      res = await this.post("/faxes", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connection_id: this.config.connectionId,
          media_name: mediaName,
          to: this.config.ownNumber,
          from: this.config.fromNumber,
          client_state: bytesToBase64(new TextEncoder().encode(JSON.stringify(state))),
        }),
      });
    } catch (err) {
      if (err instanceof DefiniteFailureError) this.config.sendLog.release(key);
      throw err;
    }
    const data = JSON.parse(res.text) as { data?: { id?: unknown } };
    const id = data.data?.id;
    if (typeof id !== "string" || !id) throw new Error(`${LABEL} returned no fax ID.`);
    return { externalId: id, simulated: false };
  }

  // Found, or nothing was ever sent, are the only definite answers. The
  // provider has no dedupe, so a send it does not list may still land, and
  // no amount of waiting makes that absent: it is never resent from here.
  async check(idempotencyKey: string, personId: string): Promise<CheckOutcome> {
    const key = await downstreamKey(personId, idempotencyKey);
    if (!this.config.sendLog.wasSent(key)) return { found: false };
    for (let page = 1; page <= MAX_LIST_PAGES; page++) {
      const body = await this.listPage(page);
      for (const fax of body.data) {
        if (typeof fax.id === "string" && fax.id && readClientState(fax.client_state)?.key === key) {
          return { found: true, externalId: fax.id, simulated: false };
        }
      }
      if (page >= body.totalPages) {
        throw new UnconfirmedSendError("Mano could not confirm this fax went through, so it was not sent again. Only a fresh approval can send it.");
      }
    }
    throw new Error(`${LABEL} check could not read the whole list.`);
  }

  private async listPage(page: number): Promise<{ data: { id?: unknown; client_state?: unknown }[]; totalPages: number }> {
    const query = new URLSearchParams({
      "filter[to][eq]": this.config.ownNumber,
      "filter[direction][eq]": "outbound",
      "page[size]": String(PAGE_SIZE),
      "page[number]": String(page),
    });
    const res = await providerFetch(
      this.fetchFn,
      `${BASE_URL}/faxes?${query}`,
      { headers: { authorization: this.authorization } },
      this.timeoutMs,
      LABEL,
    );
    if (!res.ok) throw new Error(`${LABEL} check failed: ${res.status}`);
    const body = JSON.parse(res.text) as { data?: { id?: unknown; client_state?: unknown }[]; meta?: { total_pages?: unknown } };
    if (!Array.isArray(body.data) || typeof body.meta?.total_pages !== "number") {
      throw new Error(`${LABEL} check returned malformed data.`);
    }
    return { data: body.data, totalPages: body.meta.total_pages };
  }
}

export function readClientState(value: unknown): FaxClientState | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(atob(value)) as Partial<FaxClientState>;
    return typeof parsed.key === "string" && typeof parsed.personId === "string" ? { key: parsed.key, personId: parsed.personId } : null;
  } catch {
    return null;
  }
}
