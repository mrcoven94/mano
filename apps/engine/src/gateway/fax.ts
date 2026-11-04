import { boundFetch } from "../fetch.js";
import { bytesToBase64 } from "../hash.js";
import type { ActionRequest, CheckOutcome, Executor } from "./types.js";
import { DefiniteFailureError } from "./types.js";
import {
  FAX_RECIPIENT,
  PAYLOAD,
  assertAccepted,
  assertAnswered,
  downstreamKey,
  prepareOutgoing,
  providerFetch,
  type OutboundPricing,
} from "./outbound.js";

// Faxes a document to our own number through Telnyx. POST /media uploads
// the PDF, POST /faxes sends it. The fax endpoint takes no idempotency key,
// so the key travels in client_state, and GET /faxes filtered to our number
// is the lookup that answers whether it ever sent.
const BASE_URL = "https://api.telnyx.com/v2";
const LABEL = "The fax provider";
const PAGE_SIZE = 250;
// With no dedupe at the provider, a request that timed out may still land
// after a lookup says it is not there. So a "not there" within this long
// of our own send is not believed, and the attempt stays unknown.
const SETTLE_MS = 5 * 60_000;

export interface FaxConfig {
  apiKey: string;
  connectionId: string;
  // The only number a fax may go to, and the number it is sent from.
  ownNumber: string;
  fromNumber: string;
  pricing: OutboundPricing;
}

export interface FaxClientState {
  key: string;
  personId: string;
}

export class FaxExecutor implements Executor {
  readonly simulated = false;
  private sentAt = new Map<string, number>();

  constructor(
    private config: FaxConfig,
    private fetchFn: typeof fetch = boundFetch,
    private timeoutMs = 20000,
    private now: () => number = Date.now,
  ) {}

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

  private async post(path: string, init: RequestInit): Promise<Response> {
    const headers = { authorization: this.authorization, ...init.headers };
    const res = await providerFetch(this.fetchFn, `${BASE_URL}${path}`, { ...init, method: "POST", headers }, this.timeoutMs, LABEL);
    assertAccepted(res, LABEL);
    return res;
  }

  async execute(req: ActionRequest): Promise<{ externalId: string; simulated: boolean }> {
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
    // The provider keeps its copy of the document only as long as sending takes.
    media.set("ttl_secs", "3600");
    await this.post("/media", { body: media });
    this.sentAt.set(key, this.now());
    const res = await this.post("/faxes", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connection_id: this.config.connectionId,
        media_name: mediaName,
        to: this.config.ownNumber,
        from: this.config.fromNumber,
        client_state: bytesToBase64(new TextEncoder().encode(JSON.stringify(state))),
        store_media: false,
      }),
    });
    const data = (await res.json()) as { data?: { id?: unknown } };
    const id = data.data?.id;
    if (typeof id !== "string" || !id) throw new Error(`${LABEL} returned no fax ID.`);
    return { externalId: id, simulated: false };
  }

  async check(idempotencyKey: string, personId: string): Promise<CheckOutcome> {
    const key = await downstreamKey(personId, idempotencyKey);
    const query = new URLSearchParams({
      "filter[to][eq]": this.config.ownNumber,
      "filter[direction][eq]": "outbound",
      "page[size]": String(PAGE_SIZE),
    });
    const res = await providerFetch(
      this.fetchFn,
      `${BASE_URL}/faxes?${query}`,
      { headers: { authorization: this.authorization } },
      this.timeoutMs,
      LABEL,
    );
    if (!res.ok) throw new Error(`${LABEL} check failed: ${res.status}`);
    const body = (await res.json()) as { data?: { id?: unknown; client_state?: unknown }[]; meta?: { total_pages?: unknown } };
    if (!Array.isArray(body.data)) throw new Error(`${LABEL} check returned malformed data.`);
    for (const fax of body.data) {
      if (typeof fax.id === "string" && fax.id && readClientState(fax.client_state)?.key === key) {
        return { found: true, externalId: fax.id, simulated: false };
      }
    }
    // The newest page did not have it. Absent is only true of the whole list.
    if (typeof body.meta?.total_pages !== "number" || body.meta.total_pages > 1) {
      throw new Error(`${LABEL} check could not read the whole list.`);
    }
    const sent = this.sentAt.get(key);
    if (sent !== undefined && this.now() - sent < SETTLE_MS) {
      throw new Error(`${LABEL} has not settled since this fax was sent.`);
    }
    return { found: false };
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
