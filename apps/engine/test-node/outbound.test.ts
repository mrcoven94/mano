/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { inflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { ActionGateway, MapDocumentStore } from "../src/gateway/gateway.js";
import { InMemoryExecutor } from "../src/gateway/executors.js";
import { FaxExecutor } from "../src/gateway/fax.js";
import { MailExecutor } from "../src/gateway/mail.js";
import {
  DEFAULT_PRICING,
  FAX_RECIPIENT,
  MAIL_RECIPIENT,
  PAYLOAD,
  withOutboundPrice,
} from "../src/gateway/outbound.js";
import { OutboundRouter, outboundProviders } from "../src/gateway/outbound-router.js";
import { SqlApprovalStore, ensureGatewayTables } from "../src/gateway/sql-store.js";
import type { Executor, GatewayResult } from "../src/gateway/types.js";

// The fax and letter state machine against the real gateway and SQLite
// store, with fakes standing in for the providers at the HTTP boundary.

const OWN_NUMBER = "+15550100001";
const PERSON = "maria-synthetic";

function openTestStorage() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...bindings: unknown[]) {
      const trimmed = query.trimStart().toUpperCase();
      if (trimmed.startsWith("SELECT") || trimmed.startsWith("PRAGMA")) {
        const rows = db.prepare(query).all(...(bindings as never[])) as Record<string, unknown>[];
        return { toArray: () => rows, rowsWritten: 0 };
      }
      const info = db.prepare(query).run(...(bindings as never[]));
      return { toArray: () => [], rowsWritten: Number(info.changes) };
    },
  };
}

async function samplePdf(pages = 1, stamp = "letter"): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(stamp);
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]).drawText(`${stamp} page ${i + 1}`, { x: 72, y: 700 });
  return doc.save();
}

function abortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

type Timeout = "none" | "after-recording" | "before-recording";

// What Lob does: one letter per Idempotency-Key, and a lookup by metadata.
class FakeLob {
  letters = new Map<string, { id: string; file: Uint8Array; to: string }>();
  posts = 0;
  next: Timeout = "none";
  lookupDown = false;
  rejectWith: number | null = null;
  fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (init?.method === "POST") {
      this.posts += 1;
      if (this.rejectWith) return new Response("{}", { status: this.rejectWith });
      const mode = this.next;
      this.next = "none";
      if (mode === "before-recording") throw abortError();
      const form = init.body as FormData;
      const key = new Headers(init.headers).get("idempotency-key")!;
      expect(form.get("metadata[mano_key]")).toBe(key);
      if (!this.letters.has(key)) {
        this.letters.set(key, {
          id: `ltr_${this.letters.size + 1}`,
          file: new Uint8Array(await (form.get("file") as unknown as Blob).arrayBuffer()),
          to: String(form.get("to[name]")),
        });
      }
      if (mode === "after-recording") throw abortError();
      return Response.json({ id: this.letters.get(key)!.id });
    }
    if (this.lookupDown) return new Response("{}", { status: 503 });
    const found = this.letters.get(url.searchParams.get("metadata[mano_key]") ?? "");
    return Response.json({ data: found ? [{ id: found.id }] : [] });
  }) as typeof fetch;
}

// What Telnyx does: no dedupe on POST /faxes, and a list filtered by number.
class FakeTelnyx {
  faxes: { id: string; client_state: string; to: string; from: string; media_name: string }[] = [];
  media = new Map<string, Uint8Array>();
  faxPosts = 0;
  next: Timeout | "lands-late" = "none";
  held: (typeof this.faxes)[number] | null = null;
  totalPages = 1;
  fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/media")) {
      const form = init!.body as FormData;
      this.media.set(String(form.get("media_name")), new Uint8Array(await (form.get("media") as unknown as Blob).arrayBuffer()));
      return Response.json({ data: { media_name: form.get("media_name") } });
    }
    if (init?.method === "POST") {
      this.faxPosts += 1;
      const mode = this.next;
      this.next = "none";
      if (mode === "before-recording") throw abortError();
      const body = JSON.parse(String(init.body));
      const fax = { id: `fax_${this.faxPosts}`, client_state: body.client_state, to: body.to, from: body.from, media_name: body.media_name };
      if (mode === "lands-late") {
        this.held = fax;
        throw abortError();
      }
      this.faxes.push(fax);
      if (mode === "after-recording") throw abortError();
      return Response.json({ data: { id: fax.id } }, { status: 202 });
    }
    const to = url.searchParams.get("filter[to][eq]");
    return Response.json({ data: this.faxes.filter((f) => f.to === to), meta: { total_pages: this.totalPages } });
  }) as typeof fetch;
  land() {
    if (this.held) this.faxes.push(this.held);
    this.held = null;
  }
}

async function rig(providers: Partial<Record<"fax" | "mail", Executor>>, documentBytes?: Uint8Array) {
  const storage = openTestStorage() as never;
  ensureGatewayTables(storage);
  const store = new SqlApprovalStore(storage);
  const inner = new InMemoryExecutor();
  const executor = new OutboundRouter(inner, providers, (key) => store.getAttempt(key)?.actionType ?? null);
  const documents = new MapDocumentStore();
  documents.set("doc-1", documentBytes ?? (await samplePdf()));
  const gateway = new ActionGateway(store, executor, { documents, linkCheck: async () => ({ allowed: true }) });
  return { store, inner, documents, gateway };
}

function letter(over: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) {
  return {
    type: "mail",
    recipient: MAIL_RECIPIENT,
    purpose: "Maria's food benefits renewal",
    documentId: "doc-1",
    idempotencyKey: `k-${crypto.randomUUID()}`,
    actor: "foreground",
    personId: PERSON,
    payload: {
      [PAYLOAD.mailTo]: "State Benefits Office, 100 Practice Way, Sacramento, CA 95814",
      [PAYLOAD.returnAddress]: "Maria Testperson, 1 Example St, Sacramento, CA 95814",
      [PAYLOAD.approvedBy]: "Maria Testperson",
      ...payload,
    },
    ...over,
  };
}

function fax(over: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) {
  return {
    type: "fax",
    recipient: FAX_RECIPIENT,
    purpose: "Maria's food benefits renewal",
    documentId: "doc-1",
    idempotencyKey: `k-${crypto.randomUUID()}`,
    actor: "foreground",
    personId: PERSON,
    payload: { [PAYLOAD.faxTo]: OWN_NUMBER, [PAYLOAD.approvedBy]: "Maria Testperson", ...payload },
    ...over,
  };
}

// Prices the request the way Engine does before it reaches the gateway.
async function draft(gateway: ActionGateway, documents: MapDocumentStore, raw: unknown): Promise<GatewayResult> {
  const priced = await withOutboundPrice(raw, (id) => documents.getBytes(id), DEFAULT_PRICING);
  return gateway.requestAction(priced);
}

function faxExecutor(telnyx: FakeTelnyx, now: () => number = Date.now): FaxExecutor {
  return new FaxExecutor(
    { apiKey: "not-real", connectionId: "c-1", ownNumber: OWN_NUMBER, fromNumber: "+15550100002", pricing: DEFAULT_PRICING },
    telnyx.fetch,
    1000,
    now,
  );
}

// The text a PDF draws, read from its compressed page streams. pdf-lib
// writes built-in font text as hex of the character codes.
function hexTexts(pdf: Uint8Array): string {
  const raw = Buffer.from(pdf);
  let out = "";
  let at = raw.indexOf("stream\n");
  while (at !== -1) {
    const start = at + "stream\n".length;
    const end = raw.indexOf("endstream", start);
    try {
      out += inflateSync(raw.subarray(start, end)).toString("latin1");
    } catch {
      // Not a compressed stream.
    }
    at = raw.indexOf("stream\n", end + "endstream".length);
  }
  const hex = out.match(/<([0-9A-Fa-f]+)>/g) ?? [];
  return hex.map((h) => Buffer.from(h.slice(1, -1), "hex").toString("latin1")).join(" ");
}

describe("mailed letters", () => {
  it("asks with the price first, then sends once with the attestation on the letter", async () => {
    const lob = new FakeLob();
    const { gateway, documents } = await rig({ mail: new MailExecutor("test_not_real", DEFAULT_PRICING, lob.fetch) }, await samplePdf(2));
    const asked = await draft(gateway, documents, letter());
    expect(asked.status).toBe("needs_approval");
    expect(lob.posts).toBe(0);
    const frozen = JSON.parse(asked.approval!.requestJson);
    // Two document pages, the cover page and the address page.
    expect(frozen.payload[PAYLOAD.pages]).toBe(4);
    expect(frozen.payload[PAYLOAD.price]).toBe("$1.15, not charged in practice");
    const done = await gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(done.status).toBe("completed");
    expect(done.receipt).toMatchObject({ externalId: "ltr_1", simulated: true });
    const sent = [...lob.letters.values()][0];
    expect(sent.to).toBe("State Benefits Office");
    expect((await PDFDocument.load(sent.file)).getPageCount()).toBe(3);
    expect(hexTexts(sent.file)).toContain("Prepared with Mano, sent with Maria Testperson's approval.");
  });

  it("a timeout after the letter landed reconciles to it with no second send", async () => {
    const lob = new FakeLob();
    lob.next = "after-recording";
    const { gateway, documents } = await rig({ mail: new MailExecutor("test_not_real", DEFAULT_PRICING, lob.fetch) });
    const asked = await draft(gateway, documents, letter());
    const done = await gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(done.status).toBe("reconciled");
    expect(done.receipt).toMatchObject({ externalId: "ltr_1", simulated: true, actionType: "mail" });
    expect(lob.posts).toBe(1);
    expect(lob.letters.size).toBe(1);
    const again = await gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(again.status).toBe("blocked");
    expect(lob.posts).toBe(1);
  });

  it("a timeout before the letter landed stays unknown, then the same key sends it once", async () => {
    const lob = new FakeLob();
    lob.next = "before-recording";
    const { gateway, documents, store } = await rig({ mail: new MailExecutor("test_not_real", DEFAULT_PRICING, lob.fetch) });
    const asked = await draft(gateway, documents, letter());
    const first = await gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(first.status).toBe("blocked");
    expect(store.getAttempt(asked.approval!.idempotencyKey)?.status).toBe("unknown");
    const retry = await gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(retry.status).toBe("completed");
    expect(lob.posts).toBe(2);
    expect(lob.letters.size).toBe(1);
  });

  it("never sends while the lookup cannot answer", async () => {
    const lob = new FakeLob();
    lob.next = "before-recording";
    lob.lookupDown = true;
    const { gateway, documents, store } = await rig({ mail: new MailExecutor("test_not_real", DEFAULT_PRICING, lob.fetch) });
    const asked = await draft(gateway, documents, letter());
    await gateway.approveAndExecute(asked.approval!.id, PERSON);
    const retry = await gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(retry.status).toBe("blocked");
    expect(lob.posts).toBe(1);
    expect(store.getAttempt(asked.approval!.idempotencyKey)?.status).toBe("unknown");
  });

  it("an answered 4xx is a clean failure the same key can retry", async () => {
    const lob = new FakeLob();
    lob.rejectWith = 422;
    const { gateway, documents, store } = await rig({ mail: new MailExecutor("test_not_real", DEFAULT_PRICING, lob.fetch) });
    const asked = await draft(gateway, documents, letter());
    const first = await gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(first.reason).toContain("failed before anything happened");
    expect(store.getAttempt(asked.approval!.idempotencyKey)?.status).toBe("failed");
    lob.rejectWith = null;
    expect((await gateway.approveAndExecute(asked.approval!.id, PERSON)).status).toBe("completed");
    expect(lob.letters.size).toBe(1);
  });

  it("a document that changes after the question makes the approval stale", async () => {
    const lob = new FakeLob();
    const { gateway, documents } = await rig({ mail: new MailExecutor("test_not_real", DEFAULT_PRICING, lob.fetch) });
    const asked = await draft(gateway, documents, letter());
    documents.set("doc-1", await samplePdf(1, "changed"));
    const done = await gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(done.status).toBe("stale");
    expect(lob.posts).toBe(0);
  });

  it("refuses a live key before the question, and only a test key turns mail on", async () => {
    const lob = new FakeLob();
    const { gateway, documents } = await rig({ mail: new MailExecutor("live_not_real", DEFAULT_PRICING, lob.fetch) });
    const asked = await draft(gateway, documents, letter());
    expect(asked.status).toBe("blocked");
    expect(asked.reason).toContain("test mode only");
    expect(lob.posts).toBe(0);
    expect(outboundProviders({ LOB_TEST_API_KEY: "test_not_real" }).mail).toBeDefined();
    expect(outboundProviders({ LOB_API_KEY: "live_not_real" } as never).mail).toBeUndefined();
  });

  it.each([
    ["a real office", { recipient: "county-office" }, {}, "practice mailbox"],
    ["a loose address", {}, { [PAYLOAD.mailTo]: "somewhere in Sacramento" }, "both addresses"],
    ["no name to print", {}, { [PAYLOAD.approvedBy]: " " }, "name of the person"],
    ["no document", { documentId: undefined }, {}, "needs a document"],
    ["a name the letter's font cannot print", {}, { [PAYLOAD.approvedBy]: "\u041c\u0430\u0440\u0438\u044f" }, "exactly as written"],
  ])("refuses %s before the question", async (_name, over, payload, reason) => {
    const lob = new FakeLob();
    const { gateway, documents } = await rig({ mail: new MailExecutor("test_not_real", DEFAULT_PRICING, lob.fetch) });
    const asked = await draft(gateway, documents, letter(over, payload));
    expect(asked.status).toBe("blocked");
    expect(asked.reason).toContain(reason);
    expect(lob.posts).toBe(0);
  });

  it("replaces a caller's price with Engine's, and refuses a request that skips pricing", async () => {
    const lob = new FakeLob();
    const { gateway, documents } = await rig({ mail: new MailExecutor("test_not_real", DEFAULT_PRICING, lob.fetch) });
    const asked = await draft(gateway, documents, letter({}, { [PAYLOAD.price]: "$0.01", [PAYLOAD.pages]: 1 }));
    expect(JSON.parse(asked.approval!.requestJson).payload[PAYLOAD.price]).toBe("$1.05, not charged in practice");
    const unpriced = await gateway.requestAction(letter({}, { [PAYLOAD.price]: "$0.01", [PAYLOAD.pages]: 3 }));
    expect(unpriced.status).toBe("blocked");
    expect(unpriced.reason).toContain("price");
  });

  it("refuses more pages than an envelope takes, and a file that is not a document", async () => {
    const lob = new FakeLob();
    const big = await rig({ mail: new MailExecutor("test_not_real", DEFAULT_PRICING, lob.fetch) }, await samplePdf(5));
    expect((await draft(big.gateway, big.documents, letter())).reason).toContain("at most 6");
    const odd = await rig({ mail: new MailExecutor("test_not_real", DEFAULT_PRICING, lob.fetch) }, new TextEncoder().encode("plain text"));
    expect((await draft(odd.gateway, odd.documents, letter())).reason).toContain("could not open");
  });

  it("renders the same bytes for the same request, so a retry sends the first try's letter", async () => {
    const lobs = [new FakeLob(), new FakeLob()];
    const pdf = await samplePdf();
    const raw = letter();
    for (const lob of lobs) {
      const { gateway, documents } = await rig({ mail: new MailExecutor("test_not_real", DEFAULT_PRICING, lob.fetch) }, pdf);
      const asked = await draft(gateway, documents, raw);
      await gateway.approveAndExecute(asked.approval!.id, PERSON);
    }
    const [a, b] = lobs.map((lob) => Buffer.from([...lob.letters.values()][0].file).toString("hex"));
    expect(a).toBe(b);
  });
});

describe("faxes", () => {
  it("sends one fax to our own number with the key in client_state and a real receipt", async () => {
    const telnyx = new FakeTelnyx();
    const { gateway, documents } = await rig({ fax: faxExecutor(telnyx) });
    const asked = await draft(gateway, documents, fax());
    const frozen = JSON.parse(asked.approval!.requestJson);
    expect(frozen.payload[PAYLOAD.pages]).toBe(2);
    expect(frozen.payload[PAYLOAD.price]).toBe("$0.04, not charged on the test line");
    const done = await gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(done.receipt).toMatchObject({ externalId: "fax_1", simulated: false, actionType: "fax" });
    expect(telnyx.faxes[0].to).toBe(OWN_NUMBER);
    expect(JSON.parse(atob(telnyx.faxes[0].client_state)).personId).toBe(PERSON);
    expect(hexTexts(telnyx.media.get(telnyx.faxes[0].media_name)!)).toContain("sent with Maria Testperson's approval.");
  });

  it.each([
    ["any other recipient", { recipient: "fax:+12025550143" }, {}],
    ["any other number on our recipient", {}, { [PAYLOAD.faxTo]: "+12025550143" }],
  ])("refuses %s before the question", async (_name, over, payload) => {
    const telnyx = new FakeTelnyx();
    const { gateway, documents } = await rig({ fax: faxExecutor(telnyx) });
    const asked = await draft(gateway, documents, fax(over, payload));
    expect(asked.status).toBe("blocked");
    expect(asked.reason).toContain("its own test line");
    expect(telnyx.faxPosts).toBe(0);
  });

  it("a timeout after the fax landed reconciles to it with no second send", async () => {
    const telnyx = new FakeTelnyx();
    telnyx.next = "after-recording";
    const { gateway, documents } = await rig({ fax: faxExecutor(telnyx) });
    const asked = await draft(gateway, documents, fax());
    const done = await gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(done.status).toBe("reconciled");
    expect(done.receipt).toMatchObject({ externalId: "fax_1", simulated: false });
    expect(telnyx.faxPosts).toBe(1);
  });

  it("a fax that lands after the lookup said no is not sent twice", async () => {
    const telnyx = new FakeTelnyx();
    telnyx.next = "lands-late";
    const { gateway, documents, store } = await rig({ fax: faxExecutor(telnyx) });
    const asked = await draft(gateway, documents, fax());
    const first = await gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(first.status).toBe("blocked");
    expect(store.getAttempt(asked.approval!.idempotencyKey)?.status).toBe("unknown");
    // The lookup still says no, but too soon after our send to believe it.
    const tooSoon = await gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(tooSoon.status).toBe("blocked");
    expect(telnyx.faxPosts).toBe(1);
    telnyx.land();
    const settled = await gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(settled.status).toBe("reconciled");
    expect(telnyx.faxPosts).toBe(1);
    expect(telnyx.faxes).toHaveLength(1);
  });

  it("sends again only after the settling window with the lookup still saying no", async () => {
    const telnyx = new FakeTelnyx();
    telnyx.next = "before-recording";
    let now = 1_000_000;
    const { gateway, documents } = await rig({ fax: faxExecutor(telnyx, () => now) });
    const asked = await draft(gateway, documents, fax());
    await gateway.approveAndExecute(asked.approval!.id, PERSON);
    now += 6 * 60_000;
    const retry = await gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(retry.status).toBe("completed");
    expect(telnyx.faxPosts).toBe(2);
    expect(telnyx.faxes).toHaveLength(1);
  });

  it("does not call a fax absent when the list has pages it did not read", async () => {
    const telnyx = new FakeTelnyx();
    telnyx.next = "before-recording";
    telnyx.totalPages = 2;
    let now = 1_000_000;
    const { gateway, documents } = await rig({ fax: faxExecutor(telnyx, () => now) });
    const asked = await draft(gateway, documents, fax());
    await gateway.approveAndExecute(asked.approval!.id, PERSON);
    now += 6 * 60_000;
    expect((await gateway.approveAndExecute(asked.approval!.id, PERSON)).status).toBe("blocked");
    expect(telnyx.faxPosts).toBe(1);
  });
});

describe("routing", () => {
  it("with no provider set, the stand-in labels the action simulated and the provider is untouched", async () => {
    const { gateway, documents, inner } = await rig({});
    const asked = await draft(gateway, documents, fax());
    const done = await gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(done.receipt?.simulated).toBe(true);
    expect(inner.calls).toHaveLength(1);
  });

  it("a fax needs every setting before it turns on", () => {
    const all = { TELNYX_API_KEY: "x", TELNYX_FAX_CONNECTION_ID: "c", MANO_OWN_FAX_NUMBER: OWN_NUMBER, MANO_FAX_FROM_NUMBER: "+15550100002" };
    expect(outboundProviders(all).fax).toBeDefined();
    for (const key of Object.keys(all)) {
      expect(outboundProviders({ ...all, [key]: undefined }).fax).toBeUndefined();
    }
  });

  it("reconcile follows the attempt's action, not the shape of the key", async () => {
    const lob = new FakeLob();
    lob.next = "after-recording";
    const telnyx = new FakeTelnyx();
    const { gateway, documents } = await rig({
      mail: new MailExecutor("test_not_real", DEFAULT_PRICING, lob.fetch),
      fax: faxExecutor(telnyx),
    });
    const asked = await draft(gateway, documents, letter({ idempotencyKey: "fax:looks-like-a-fax" }));
    const done = await gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(done.status).toBe("reconciled");
    expect(done.receipt?.externalId).toBe("ltr_1");
  });
});
