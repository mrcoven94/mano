import { boundFetch } from "../fetch.js";
import type { DeliveryRoutes } from "./delivery.js";
import type { ActionRequest, CheckOutcome, Executor } from "./types.js";
import { DefiniteFailureError } from "./types.js";
import {
  MAIL_RECIPIENT,
  PAYLOAD,
  assertAccepted,
  assertAnswered,
  downstreamKey,
  prepareOutgoing,
  providerFetch,
  providerIdentity,
  type OutboundPricing,
} from "./outbound.js";

// Mails a letter through Lob's test mode: Lob renders it and files it in
// the test log, and prints and mails nothing. Receipts are labeled
// simulated for that reason. A live key is refused here, so sending real
// mail takes a code change and a decision, not a setting.
//
// POST /v1/letters carries the Idempotency-Key header, so a retry of the
// same key returns the same letter. GET /v1/letters filtered by the
// mano_key metadata answers whether the key ever sent.
const BASE_URL = "https://api.lob.com/v1";
const LABEL = "The mail provider";
const ADDRESS = /^([^,]+), ([^,]+), ([^,]+), ([A-Z]{2}) (\d{5}(?:-\d{4})?)$/;

interface MailAddress {
  name: string;
  address_line1: string;
  address_city: string;
  address_state: string;
  address_zip: string;
}

function parseAddress(value: unknown): MailAddress | null {
  const match = typeof value === "string" ? ADDRESS.exec(value) : null;
  if (!match) return null;
  return { name: match[1], address_line1: match[2], address_city: match[3], address_state: match[4], address_zip: match[5] };
}

export class MailExecutor implements Executor {
  readonly simulated = true;
  readonly provider: string;

  constructor(
    private apiKey: string,
    private pricing: OutboundPricing,
    private fetchFn: typeof fetch = boundFetch,
    private timeoutMs = 20000,
    private routes?: DeliveryRoutes,
  ) {
    this.provider = providerIdentity("lob", apiKey);
  }

  private get authorization(): string {
    return `Basic ${btoa(`${this.apiKey}:`)}`;
  }

  private addresses(req: ActionRequest): { to: MailAddress; from: MailAddress } | { problem: string } {
    if (!this.apiKey.startsWith("test_")) return { problem: "Mano sends letters in test mode only." };
    if (req.recipient !== MAIL_RECIPIENT) return { problem: "Mano can only send a letter to its practice mailbox for now." };
    const to = parseAddress(req.payload[PAYLOAD.mailTo]);
    const from = parseAddress(req.payload[PAYLOAD.returnAddress]);
    if (!to || !from) return { problem: "A letter needs both addresses written as: Name, Street, City, ST 12345." };
    return { to, from };
  }

  // Lob redacts metadata in its webhooks but not the letter's own ID, so the
  // route from that ID to the person is kept here. A failed write never costs
  // the send: the webhook goes unacknowledged, and Lob sends it again.
  private async rememberRoute(letterId: string, personId: string): Promise<void> {
    try {
      await this.routes?.remember(letterId, personId);
    } catch {
      console.warn(JSON.stringify({ type: "mano_delivery_route_failed" }));
    }
  }

  async refuse(req: ActionRequest): Promise<string | null> {
    const addresses = this.addresses(req);
    if ("problem" in addresses) return addresses.problem;
    const outgoing = await prepareOutgoing(req, "mail", this.pricing);
    return outgoing.ok ? null : outgoing.problem;
  }

  async execute(req: ActionRequest): Promise<{ externalId: string; simulated: boolean }> {
    assertAnswered(req);
    const addresses = this.addresses(req);
    if ("problem" in addresses) throw new DefiniteFailureError(addresses.problem);
    const outgoing = await prepareOutgoing(req, "mail", this.pricing);
    if (!outgoing.ok) throw new DefiniteFailureError(outgoing.problem);
    const key = await downstreamKey(req.personId, req.idempotencyKey);
    const form = new FormData();
    form.set("description", key);
    for (const [side, address] of Object.entries(addresses)) {
      for (const [field, value] of Object.entries(address)) form.set(`${side}[${field}]`, value);
    }
    form.set("color", "false");
    form.set("use_type", "operational");
    form.set("address_placement", "insert_blank_page");
    form.set("metadata[mano_key]", key);
    form.set("file", new Blob([outgoing.pdf], { type: "application/pdf" }), "letter.pdf");
    const res = await providerFetch(
      this.fetchFn,
      `${BASE_URL}/letters`,
      { method: "POST", headers: { authorization: this.authorization, "idempotency-key": key }, body: form },
      this.timeoutMs,
      LABEL,
    );
    assertAccepted(res, LABEL);
    const data = JSON.parse(res.text) as { id?: unknown };
    if (typeof data.id !== "string" || !data.id) throw new Error(`${LABEL} returned no letter ID.`);
    await this.rememberRoute(data.id, req.personId);
    return { externalId: data.id, simulated: true };
  }

  async check(idempotencyKey: string, personId: string): Promise<CheckOutcome> {
    const key = await downstreamKey(personId, idempotencyKey);
    const query = new URLSearchParams({ "metadata[mano_key]": key, limit: "1" });
    const res = await providerFetch(
      this.fetchFn,
      `${BASE_URL}/letters?${query}`,
      { headers: { authorization: this.authorization } },
      this.timeoutMs,
      LABEL,
    );
    if (!res.ok) throw new Error(`${LABEL} check failed: ${res.status}`);
    const data = JSON.parse(res.text) as { data?: { id?: unknown }[] };
    if (!Array.isArray(data.data)) throw new Error(`${LABEL} check returned malformed data.`);
    const id = data.data[0]?.id;
    if (data.data.length === 0) return { found: false };
    if (typeof id !== "string" || !id) throw new Error(`${LABEL} check returned malformed data.`);
    await this.rememberRoute(id, personId);
    return { found: true, externalId: id, simulated: true };
  }
}
