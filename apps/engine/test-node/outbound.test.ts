/// <reference types="node" />
import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { inflateSync } from "node:zlib";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFStream, degrees, type PDFObject } from "pdf-lib";
import { ActionGateway, MapDocumentStore } from "../src/gateway/gateway.js";
import { InMemoryExecutor, SandboxExecutor } from "../src/gateway/executors.js";
import { FaxExecutor, SqlFaxSendLog, ensureFaxSendTable, type FaxSendLog } from "../src/gateway/fax.js";
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
  forms: FormData[] = [];
  next: Timeout | "lands-late" = "none";
  held: { key: string; letter: { id: string; file: Uint8Array; to: string } } | null = null;
  land() {
    if (this.held && !this.letters.has(this.held.key)) this.letters.set(this.held.key, this.held.letter);
    this.held = null;
  }
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
      this.forms.push(form);
      const key = new Headers(init.headers).get("idempotency-key")!;
      expect(form.get("metadata[mano_key]")).toBe(key);
      if (mode === "lands-late") {
        this.held = { key, letter: { id: "ltr_late", file: new Uint8Array(), to: String(form.get("to[name]")) } };
        throw abortError();
      }
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
  next: Timeout | "lands-late" | "crash" = "none";
  rejectWith: number | null = null;
  held: (typeof this.faxes)[number] | null = null;
  lookupDown = false;
  mediaTimesOutNext = false;
  hangBodyNext = false;
  listCalls = 0;
  pageSize = 250;
  mediaTtl: string | null = null;
  fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/media")) {
      if (this.mediaTimesOutNext) {
        this.mediaTimesOutNext = false;
        throw abortError();
      }
      const form = init!.body as FormData;
      this.media.set(String(form.get("media_name")), new Uint8Array(await (form.get("media") as unknown as Blob).arrayBuffer()));
      this.mediaTtl = String(form.get("ttl_secs"));
      return Response.json({ data: { media_name: form.get("media_name") } });
    }
    if (init?.method === "POST") {
      this.faxPosts += 1;
      if (this.rejectWith) return new Response("{}", { status: this.rejectWith });
      const mode = this.next;
      this.next = "none";
      if (mode === "before-recording") throw abortError();
      const body = JSON.parse(String(init.body));
      // The provider's contract: store_media does not support media_name.
      if ("store_media" in body && body.media_name) return Response.json({ errors: [{ code: "10015" }] }, { status: 422 });
      const fax = { id: `fax_${this.faxPosts}`, client_state: body.client_state, to: body.to, from: body.from, media_name: body.media_name };
      if (mode === "lands-late") {
        this.held = fax;
        throw abortError();
      }
      this.faxes.push(fax);
      if (mode === "after-recording") throw abortError();
      if (mode === "crash") return new Promise<Response>(() => {});
      if (this.hangBodyNext) {
        this.hangBodyNext = false;
        const body = new ReadableStream({
          start(controller) {
            init.signal?.addEventListener("abort", () => controller.error(abortError()));
          },
        });
        return new Response(body, { status: 202 });
      }
      return Response.json({ data: { id: fax.id } }, { status: 202 });
    }
    this.listCalls += 1;
    if (this.lookupDown) return new Response("{}", { status: 503 });
    const to = url.searchParams.get("filter[to][eq]");
    const matching = this.faxes.filter((f) => f.to === to);
    const page = Number(url.searchParams.get("page[number]") ?? 1);
    const start = (page - 1) * this.pageSize;
    return Response.json({ data: matching.slice(start, start + this.pageSize), meta: { total_pages: Math.max(1, Math.ceil(matching.length / this.pageSize)) } });
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
  const executor = new OutboundRouter(inner, providers, (key) => store.getAttempt(key));
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
async function draft(gateway: ActionGateway, documents: MapDocumentStore, raw: unknown, turn?: { turnId: string; receivedAt: string }): Promise<GatewayResult> {
  const priced = await withOutboundPrice(raw, (id) => documents.getBytes(id), DEFAULT_PRICING, () => null);
  return gateway.requestAction(priced, new Date(), turn ? { proposal: turn } : {});
}

const TURN_1 = { turnId: "turn-1", receivedAt: "2026-11-03T10:00:00.000Z" };
const TURN_2 = { turnId: "turn-2", receivedAt: "2026-11-03T10:05:00.000Z" };

function memoryLog(): FaxSendLog {
  const sent = new Set<string>();
  return { wasSent: (key) => sent.has(key), markSent: (key) => void sent.add(key) };
}

function faxExecutor(telnyx: FakeTelnyx): FaxExecutor {
  return new FaxExecutor(
    { apiKey: "not-real", connectionId: "c-1", ownNumber: OWN_NUMBER, fromNumber: "+15550100002", pricing: DEFAULT_PRICING, sendLog: memoryLog() },
    telnyx.fetch,
    1000,
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

// The text a page really draws: its content streams and the form objects
// they can reach. An appearance stream left behind in the file with nothing
// drawing it does not count.
function drawnText(doc: PDFDocument, pageIndex: number): string {
  const decode = (stream: PDFStream): string => {
    const raw = Buffer.from((stream as PDFRawStream).contents);
    let text: string;
    try {
      text = inflateSync(raw).toString("latin1");
    } catch {
      text = raw.toString("latin1");
    }
    return (text.match(/<([0-9A-Fa-f]+)>/g) ?? []).map((h) => Buffer.from(h.slice(1, -1), "hex").toString("latin1")).join(" ");
  };
  const fromResources = (resources: PDFObject | undefined): string => {
    if (!(resources instanceof PDFDict)) return "";
    const forms = resources.lookup(PDFName.of("XObject"));
    if (!(forms instanceof PDFDict)) return "";
    return forms
      .keys()
      .map((name) => {
        const form = forms.lookup(name);
        return form instanceof PDFStream ? `${decode(form)} ${fromResources(form.dict.lookup(PDFName.of("Resources")))}` : "";
      })
      .join(" ");
  };
  const node = doc.getPage(pageIndex).node;
  const contents = node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => doc.context.lookup(ref)) : [contents];
  const own = streams.map((s) => (s instanceof PDFStream ? decode(s) : "")).join(" ");
  return `${own} ${fromResources(node.Resources())}`;
}

describe("mailed letters", () => {
  it("asks with the price first, then sends once with the attestation on the letter", async () => {
    const lob = new FakeLob();
    const { gateway, documents, store } = await rig({ mail: new MailExecutor("test_not_real", DEFAULT_PRICING, lob.fetch) }, await samplePdf(2));
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
    expect(store.getAttempt(asked.approval!.idempotencyKey)?.status).toBe("done");
    expect(store.getReceiptByKey(asked.approval!.idempotencyKey)?.externalId).toBe("ltr_1");
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
    expect(again).toMatchObject({ status: "completed", replayed: true, receipt: { externalId: "ltr_1" } });
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

  it("a letter that lands after the lookup said no is one letter, because the provider dedupes the key", async () => {
    const lob = new FakeLob();
    lob.next = "lands-late";
    const { gateway, documents, store } = await rig({ mail: new MailExecutor("test_not_real", DEFAULT_PRICING, lob.fetch) });
    const asked = await draft(gateway, documents, letter());
    expect((await gateway.approveAndExecute(asked.approval!.id, PERSON)).status).toBe("blocked");
    expect(store.getAttempt(asked.approval!.idempotencyKey)?.status).toBe("unknown");
    const retry = await gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(retry.status).toBe("completed");
    lob.land();
    expect(lob.posts).toBe(2);
    expect(lob.letters.size).toBe(1);
  });

  it("writes down each letter's person, on the send and on a reconcile, and sends no person to the provider", async () => {
    const lob = new FakeLob();
    const remembered: [string, string][] = [];
    const routes = { remember: async (id: string, person: string) => void remembered.push([id, person]) };
    const { gateway, documents } = await rig({ mail: new MailExecutor("test_not_real", DEFAULT_PRICING, lob.fetch, 1000, routes) });
    const asked = await draft(gateway, documents, letter());
    await gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(remembered).toEqual([["ltr_1", PERSON]]);
    expect(lob.forms[0].get("metadata[mano_person]")).toBeNull();
    const after = new FakeLob();
    after.next = "after-recording";
    const second = await rig({ mail: new MailExecutor("test_not_real", DEFAULT_PRICING, after.fetch, 1000, routes) });
    const again = await draft(second.gateway, second.documents, letter());
    await second.gateway.approveAndExecute(again.approval!.id, PERSON);
    expect(remembered[1]).toEqual(["ltr_1", PERSON]);
  });

  it("a route it cannot write never costs the send", async () => {
    const lob = new FakeLob();
    const routes = { remember: async () => { throw new Error("storage is down"); } };
    const { gateway, documents } = await rig({ mail: new MailExecutor("test_not_real", DEFAULT_PRICING, lob.fetch, 1000, routes) });
    const asked = await draft(gateway, documents, letter());
    expect((await gateway.approveAndExecute(asked.approval!.id, PERSON)).status).toBe("completed");
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
    expect(outboundProviders({ LOB_TEST_API_KEY: "test_not_real" }, memoryLog()).mail).toBeDefined();
    expect(outboundProviders({ LOB_API_KEY: "live_not_real" } as never, memoryLog()).mail).toBeUndefined();
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

  it("a fax that lands after the lookup said no is not sent twice, however long it takes", async () => {
    const telnyx = new FakeTelnyx();
    telnyx.next = "lands-late";
    const { gateway, documents, store } = await rig({ fax: faxExecutor(telnyx) });
    const asked = await draft(gateway, documents, fax());
    const first = await gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(first.status).toBe("blocked");
    expect(store.getAttempt(asked.approval!.idempotencyKey)?.status).toBe("unknown");
    const replay = await gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(replay.status).toBe("blocked");
    expect(replay.unconfirmed).toBe(true);
    expect(telnyx.faxPosts).toBe(1);
    telnyx.land();
    const settled = await gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(settled.status).toBe("reconciled");
    expect(telnyx.faxPosts).toBe(1);
    expect(telnyx.faxes).toHaveLength(1);
  });

  it("a fresh approval sends it again under its own key", async () => {
    const telnyx = new FakeTelnyx();
    telnyx.next = "before-recording";
    const { gateway, documents } = await rig({ fax: faxExecutor(telnyx) });
    const asked = await draft(gateway, documents, fax(), TURN_1);
    await gateway.approveAndExecute(asked.approval!.id, PERSON);
    const fresh = await draft(gateway, documents, fax(), TURN_2);
    expect(fresh.status).toBe("needs_approval");
    expect((await gateway.approveAndExecute(fresh.approval!.id, PERSON)).status).toBe("completed");
    expect(telnyx.faxes).toHaveLength(1);
  });

  it("a timeout on the upload, before any fax was sent, may try again", async () => {
    const telnyx = new FakeTelnyx();
    telnyx.mediaTimesOutNext = true;
    const { gateway, documents } = await rig({ fax: faxExecutor(telnyx) });
    const asked = await draft(gateway, documents, fax());
    expect((await gateway.approveAndExecute(asked.approval!.id, PERSON)).status).toBe("blocked");
    expect(telnyx.faxPosts).toBe(0);
    expect(telnyx.listCalls).toBe(0);
    expect((await gateway.approveAndExecute(asked.approval!.id, PERSON)).status).toBe("completed");
    expect(telnyx.faxes).toHaveLength(1);
  });

  it("a provider refusal is a definite answer, so the same key may try again", async () => {
    const telnyx = new FakeTelnyx();
    telnyx.rejectWith = 422;
    const { gateway, documents, store } = await rig({ fax: faxExecutor(telnyx) });
    const asked = await draft(gateway, documents, fax());
    await gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(store.getAttempt(asked.approval!.idempotencyKey)?.status).toBe("failed");
    telnyx.rejectWith = null;
    expect((await gateway.approveAndExecute(asked.approval!.id, PERSON)).status).toBe("completed");
    expect(telnyx.faxes).toHaveLength(1);
  });

  it("a response body that hangs after the provider accepted counts as a timeout, and is found by the lookup", async () => {
    const telnyx = new FakeTelnyx();
    telnyx.hangBodyNext = true;
    const executor = new FaxExecutor(
      { apiKey: "not-real", connectionId: "c-1", ownNumber: OWN_NUMBER, fromNumber: "+15550100002", pricing: DEFAULT_PRICING, sendLog: memoryLog() },
      telnyx.fetch,
      50,
    );
    const { gateway, documents } = await rig({ fax: executor });
    const asked = await draft(gateway, documents, fax());
    const done = await gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(done.status).toBe("reconciled");
    expect(telnyx.faxPosts).toBe(1);
  });

  it("the lookup finds a fax on a later page of the list", async () => {
    const telnyx = new FakeTelnyx();
    telnyx.pageSize = 2;
    telnyx.faxes.push(
      { id: "fax_a", client_state: "", to: OWN_NUMBER, from: "", media_name: "" },
      { id: "fax_b", client_state: "", to: OWN_NUMBER, from: "", media_name: "" },
    );
    telnyx.next = "after-recording";
    const { gateway, documents } = await rig({ fax: faxExecutor(telnyx) });
    const asked = await draft(gateway, documents, fax());
    const done = await gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(done.status).toBe("reconciled");
    expect(telnyx.faxPosts).toBe(1);
  });
});

describe("after the person corrects a fax or letter", () => {
  function mailRig(lob: FakeLob) {
    return rig({ mail: new MailExecutor("test_not_real", DEFAULT_PRICING, lob.fetch) });
  }

  it("a retired letter is never sent again", async () => {
    const lob = new FakeLob();
    lob.rejectWith = 422;
    const { gateway, documents } = await mailRig(lob);
    const asked = await draft(gateway, documents, letter());
    await gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect((await gateway.retireApproval(asked.approval!.id, PERSON)).approval?.status).toBe("retired");
    lob.rejectWith = null;
    const retry = await gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(retry.status).toBe("blocked");
    expect(retry.reason).toContain("replaced by a correction");
    expect(lob.posts).toBe(1);
    expect(lob.letters.size).toBe(0);
  });

  it("a retired fax is never sent again", async () => {
    const telnyx = new FakeTelnyx();
    telnyx.rejectWith = 422;
    const { gateway, documents } = await rig({ fax: faxExecutor(telnyx) });
    const asked = await draft(gateway, documents, fax());
    await gateway.approveAndExecute(asked.approval!.id, PERSON);
    await gateway.retireApproval(asked.approval!.id, PERSON);
    telnyx.rejectWith = null;
    expect((await gateway.approveAndExecute(asked.approval!.id, PERSON)).status).toBe("blocked");
    expect(telnyx.faxPosts).toBe(1);
    expect(telnyx.faxes).toHaveLength(0);
  });

  it("a letter a newer proposal replaced is reconciled, then never sent", async () => {
    const lob = new FakeLob();
    lob.next = "before-recording";
    const { gateway, documents } = await mailRig(lob);
    const asked = await draft(gateway, documents, letter(), TURN_1);
    await gateway.approveAndExecute(asked.approval!.id, PERSON);
    await draft(gateway, documents, letter(), TURN_2);
    const retry = await gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(retry.superseded).toBe(true);
    expect(lob.posts).toBe(1);
    expect(lob.letters.size).toBe(0);
  });

  it("a fax a newer proposal replaced is looked up and never sent", async () => {
    const telnyx = new FakeTelnyx();
    telnyx.next = "before-recording";
    const { gateway, documents } = await rig({ fax: faxExecutor(telnyx) });
    const asked = await draft(gateway, documents, fax(), TURN_1);
    await gateway.approveAndExecute(asked.approval!.id, PERSON);
    await draft(gateway, documents, fax(), TURN_2);
    const retry = await gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(retry.status).toBe("blocked");
    expect(telnyx.faxPosts).toBe(1);
    expect(telnyx.faxes).toHaveLength(0);
  });

  it("a letter that did go out answers its receipt even though a newer proposal replaced it", async () => {
    const lob = new FakeLob();
    lob.next = "after-recording";
    lob.lookupDown = true;
    const { gateway, documents, store } = await mailRig(lob);
    const asked = await draft(gateway, documents, letter(), TURN_1);
    expect((await gateway.approveAndExecute(asked.approval!.id, PERSON)).status).toBe("blocked");
    await draft(gateway, documents, letter(), TURN_2);
    lob.lookupDown = false;
    const retry = await gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(retry.status).toBe("reconciled");
    expect(retry.receipt).toMatchObject({ externalId: "ltr_1", simulated: true, actionType: "mail" });
    expect(store.getAttempt(asked.approval!.idempotencyKey)?.status).toBe("done");
    expect(lob.posts).toBe(1);
  });

  it("a draft from before a correction cannot be approved", async () => {
    const lob = new FakeLob();
    const { gateway, documents, store } = await mailRig(lob);
    const asked = await draft(gateway, documents, letter(), TURN_1);
    await gateway.fenceProposals(MAIL_RECIPIENT, TURN_2, store.generation());
    expect((await gateway.approveAndExecute(asked.approval!.id, PERSON)).status).toBe("blocked");
    expect(lob.posts).toBe(0);
  });

  it("recovery settles a stranded letter with its simulated label, and sends nothing", async () => {
    const lob = new FakeLob();
    lob.next = "after-recording";
    lob.lookupDown = true;
    const { gateway, documents, store } = await mailRig(lob);
    const asked = await draft(gateway, documents, letter());
    await gateway.approveAndExecute(asked.approval!.id, PERSON);
    lob.lookupDown = false;
    const later = new Date(Date.now() + 60_000);
    const recovered = await gateway.recoverAttempt(asked.approval!.idempotencyKey, later, later.toISOString());
    expect(recovered).toMatchObject({ status: "reconciled", receipt: { externalId: "ltr_1", simulated: true } });
    expect(store.getAttempt(asked.approval!.idempotencyKey)?.status).toBe("done");
    expect(lob.posts).toBe(1);
  });

  it("recovery does not send a stranded letter a newer proposal replaced", async () => {
    const lob = new FakeLob();
    lob.next = "before-recording";
    const { gateway, documents, store } = await mailRig(lob);
    const asked = await draft(gateway, documents, letter(), TURN_1);
    await gateway.approveAndExecute(asked.approval!.id, PERSON);
    await draft(gateway, documents, letter(), TURN_2);
    const later = new Date(Date.now() + 60_000);
    const recovered = await gateway.recoverAttempt(asked.approval!.idempotencyKey, later, later.toISOString());
    expect(recovered?.superseded).toBe(true);
    expect(store.getAttempt(asked.approval!.idempotencyKey)?.status).toBe("failed");
    expect(lob.posts).toBe(1);
  });
});

describe("a fax timeout across a restart", () => {
  // One person's SQLite, and everything rebuilt over it, as a Durable
  // Object restart does: nothing held in memory survives.
  function restartable(telnyx: FakeTelnyx, documents: MapDocumentStore) {
    const storage = openTestStorage() as never;
    ensureGatewayTables(storage);
    ensureFaxSendTable(storage);
    const boot = () => {
      const store = new SqlApprovalStore(storage);
      const executor = new FaxExecutor(
        { apiKey: "not-real", connectionId: "c-1", ownNumber: OWN_NUMBER, fromNumber: "+15550100002", pricing: DEFAULT_PRICING, sendLog: new SqlFaxSendLog(storage) },
        telnyx.fetch,
        1000,
      );
      const router = new OutboundRouter(new InMemoryExecutor(), { fax: executor }, (key) => store.getAttempt(key));
      return { store, gateway: new ActionGateway(store, router, { documents, linkCheck: async () => ({ allowed: true }) }) };
    };
    return boot;
  }

  it("a YES replayed after a restart sends no second fax and says it could not confirm it", async () => {
    const telnyx = new FakeTelnyx();
    telnyx.next = "lands-late";
    const documents = new MapDocumentStore();
    documents.set("doc-1", await samplePdf());
    const boot = restartable(telnyx, documents);
    const before = boot();
    const asked = await draft(before.gateway, documents, fax());
    expect((await before.gateway.approveAndExecute(asked.approval!.id, PERSON)).status).toBe("blocked");
    expect(telnyx.faxPosts).toBe(1);

    const after = boot();
    const replay = await after.gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(replay.status).toBe("blocked");
    expect(replay.unconfirmed).toBe(true);
    expect(replay.reason).toContain("could not confirm");
    expect(after.store.getAttempt(asked.approval!.idempotencyKey)?.status).toBe("unknown");
    expect(telnyx.faxPosts).toBe(1);

    telnyx.land();
    const settled = await after.gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(settled.status).toBe("reconciled");
    expect(telnyx.faxes).toHaveLength(1);
  });

  it("a crash after the provider accepted, with lookups down past their window, still gets its receipt on a YES", async () => {
    const telnyx = new FakeTelnyx();
    telnyx.next = "crash";
    const documents = new MapDocumentStore();
    documents.set("doc-1", await samplePdf());
    const boot = restartable(telnyx, documents);
    const before = boot();
    const asked = await draft(before.gateway, documents, fax());
    void before.gateway.approveAndExecute(asked.approval!.id, PERSON);
    await vi.waitFor(() => expect(telnyx.faxPosts).toBe(1));

    const after = boot();
    const key = asked.approval!.idempotencyKey;
    expect(after.store.getAttempt(key)?.status).toBe("in_flight");
    telnyx.lookupDown = true;
    const start = Date.now();
    for (let minutes = 10; minutes <= 2 * 24 * 60; minutes += 10) {
      const now = new Date(start + minutes * 60_000);
      const cutoff = new Date(now.getTime() - 5 * 60_000).toISOString();
      for (const attempt of after.store.listRecoverableAttempts(cutoff, now.toISOString())) await after.gateway.recoverAttempt(attempt.key, now, cutoff);
    }
    expect(after.store.getAttempt(key)?.status).toBe("unknown");
    expect(after.store.hasUnresolvedAttempts()).toBe(false);
    telnyx.lookupDown = false;
    const yes = await after.gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(yes.status).toBe("reconciled");
    expect(after.store.getReceiptByKey(key)?.externalId).toBe("fax_1");
    expect(telnyx.faxPosts).toBe(1);
  }, 60_000);

  it("a YES on a crashed send looks it up once no live request can own it, and not before", async () => {
    const telnyx = new FakeTelnyx();
    telnyx.next = "crash";
    const documents = new MapDocumentStore();
    documents.set("doc-1", await samplePdf());
    const boot = restartable(telnyx, documents);
    const before = boot();
    const asked = await draft(before.gateway, documents, fax());
    void before.gateway.approveAndExecute(asked.approval!.id, PERSON);
    await vi.waitFor(() => expect(telnyx.faxPosts).toBe(1));
    const after = boot();
    expect((await after.gateway.approveAndExecute(asked.approval!.id, PERSON)).status).toBe("in_progress");
    expect(telnyx.listCalls).toBe(0);
    const later = new Date(Date.now() + 6 * 60_000);
    const yes = await after.gateway.approveAndExecute(asked.approval!.id, PERSON, later);
    expect(yes.status).toBe("reconciled");
    expect(telnyx.faxPosts).toBe(1);
  });

  it("recovery after a restart leaves the attempt unknown and sends nothing", async () => {
    const telnyx = new FakeTelnyx();
    telnyx.next = "before-recording";
    const documents = new MapDocumentStore();
    documents.set("doc-1", await samplePdf());
    const boot = restartable(telnyx, documents);
    const before = boot();
    const asked = await draft(before.gateway, documents, fax());
    await before.gateway.approveAndExecute(asked.approval!.id, PERSON);
    const after = boot();
    const later = new Date(Date.now() + 6 * 60_000);
    const recovered = await after.gateway.recoverAttempt(asked.approval!.idempotencyKey, later, later.toISOString());
    expect(recovered?.unconfirmed).toBe(true);
    expect(after.store.getAttempt(asked.approval!.idempotencyKey)?.status).toBe("unknown");
    expect(telnyx.faxPosts).toBe(1);
  });
});

describe("an outbound attempt whose provider setting went away", () => {
  const notFound = (async () => new Response("{}", { status: 404 })) as typeof fetch;

  function boots(providers: () => Partial<Record<"fax" | "mail", Executor>>, documents: MapDocumentStore) {
    const storage = openTestStorage() as never;
    ensureGatewayTables(storage);
    ensureFaxSendTable(storage);
    return (withProvider: boolean) => {
      const store = new SqlApprovalStore(storage);
      const sandbox = new SandboxExecutor("https://sandbox.test", 1000, notFound, "not-real");
      const router = new OutboundRouter(sandbox, withProvider ? providers() : {}, (key) => store.getAttempt(key));
      return { store, sandbox, gateway: new ActionGateway(store, router, { documents, linkCheck: async () => ({ allowed: true }) }) };
    };
  }

  it("a fax stays unknown, never reaches the sandbox, and is found when the setting returns", async () => {
    const telnyx = new FakeTelnyx();
    telnyx.next = "after-recording";
    telnyx.lookupDown = true;
    const documents = new MapDocumentStore();
    documents.set("doc-1", await samplePdf());
    const log = memoryLog();
    const boot = boots(
      () => ({
        fax: new FaxExecutor(
          { apiKey: "not-real", connectionId: "c-1", ownNumber: OWN_NUMBER, fromNumber: "+15550100002", pricing: DEFAULT_PRICING, sendLog: log },
          telnyx.fetch,
          1000,
        ),
      }),
      documents,
    );
    const first = boot(true);
    const asked = await draft(first.gateway, documents, fax());
    expect((await first.gateway.approveAndExecute(asked.approval!.id, PERSON)).status).toBe("blocked");
    const key = asked.approval!.idempotencyKey;
    expect(first.store.getAttempt(key)?.status).toBe("unknown");

    const missing = boot(false);
    expect((await missing.gateway.approveAndExecute(asked.approval!.id, PERSON)).status).toBe("blocked");
    expect(missing.store.getAttempt(key)?.status).toBe("unknown");
    expect(missing.sandbox.calls).toHaveLength(0);
    const later = new Date(Date.now() + 6 * 60_000);
    await missing.gateway.recoverAttempt(key, later, later.toISOString());
    expect(missing.store.getAttempt(key)?.status).toBe("unknown");
    expect(missing.sandbox.calls).toHaveLength(0);

    telnyx.lookupDown = false;
    const back = boot(true);
    expect((await back.gateway.approveAndExecute(asked.approval!.id, PERSON)).status).toBe("reconciled");
    expect(telnyx.faxPosts).toBe(1);
  });

  it("a letter stays unknown and never reaches the sandbox", async () => {
    const lob = new FakeLob();
    lob.next = "after-recording";
    lob.lookupDown = true;
    const documents = new MapDocumentStore();
    documents.set("doc-1", await samplePdf());
    const boot = boots(() => ({ mail: new MailExecutor("test_not_real", DEFAULT_PRICING, lob.fetch) }), documents);
    const first = boot(true);
    const asked = await draft(first.gateway, documents, letter());
    await first.gateway.approveAndExecute(asked.approval!.id, PERSON);
    const missing = boot(false);
    await missing.gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(missing.store.getAttempt(asked.approval!.idempotencyKey)?.status).toBe("unknown");
    expect(missing.sandbox.calls).toHaveLength(0);
    lob.lookupDown = false;
    expect((await boot(true).gateway.approveAndExecute(asked.approval!.id, PERSON)).status).toBe("reconciled");
    expect(lob.posts).toBe(1);
  });

  it("a new fax with no provider is refused before the question", async () => {
    const documents = new MapDocumentStore();
    documents.set("doc-1", await samplePdf());
    const { gateway, sandbox } = boots(() => ({}), documents)(false);
    const asked = await draft(gateway, documents, fax());
    expect(asked.status).toBe("blocked");
    expect(asked.reason).toContain("not set up");
    expect(sandbox.calls).toHaveLength(0);
  });
});

// A JPEG with no image data: enough for its size and its orientation to
// be read, stored 400 wide by 300 tall.
function jpegWithOrientation(orientation: number | null): Uint8Array {
  const exif = orientation === null ? [] : (() => {
    const tiff = [0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const body = [...new TextEncoder().encode("Exif\0\0"), ...tiff];
    const length = body.length + 2;
    return [0xff, 0xe1, length >> 8, length & 0xff, ...body];
  })();
  const sof = [0xff, 0xc0, 0, 17, 8, 300 >> 8, 300 & 0xff, 400 >> 8, 400 & 0xff, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1];
  return Uint8Array.from([0xff, 0xd8, ...exif, ...sof, 0xff, 0xd9]);
}

// Where a page's image lands: its content's transforms, applied to a point
// of the stored image (0,1 is its stored top left corner).
function imagePoint(doc: PDFDocument, pageIndex: number, point: [number, number]): [number, number] {
  const contents = doc.getPage(pageIndex).node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => doc.context.lookup(ref)) : [contents];
  const text = streams
    .map((stream) => {
      const raw = Buffer.from((stream as PDFRawStream).contents);
      try {
        return inflateSync(raw).toString("latin1");
      } catch {
        return raw.toString("latin1");
      }
    })
    .join("\n");
  const beforeDraw = text.slice(0, text.indexOf(" Do"));
  const matrices = [...beforeDraw.matchAll(/(-?[\d.e-]+) (-?[\d.e-]+) (-?[\d.e-]+) (-?[\d.e-]+) (-?[\d.e-]+) (-?[\d.e-]+) cm/g)].map((m) => m.slice(1).map(Number));
  let [x, y] = point;
  for (const [a, b, c, d, e, f] of matrices.reverse()) [x, y] = [a * x + c * y + e, b * x + d * y + f];
  return [x, y];
}

describe("a photo's stored orientation", () => {
  const send = async (bytes: Uint8Array) => {
    const lob = new FakeLob();
    const { gateway, documents } = await rig({ mail: new MailExecutor("test_not_real", DEFAULT_PRICING, lob.fetch) }, bytes);
    const asked = await draft(gateway, documents, letter());
    if (asked.status !== "needs_approval") return { asked, out: null };
    await gateway.approveAndExecute(asked.approval!.id, PERSON);
    return { asked, out: await PDFDocument.load([...lob.letters.values()][0].file) };
  };
  const MID = { x: 306, y: 396 };

  it.each([
    ["no orientation", null, ["left", "top"], ["right", "top"]],
    ["upright", 1, ["left", "top"], ["right", "top"]],
    ["upside down", 3, ["right", "bottom"], ["left", "bottom"]],
    ["turned right", 6, ["right", "top"], ["right", "bottom"]],
    ["turned left", 8, ["left", "bottom"], ["left", "top"]],
  ])("goes out the way a viewer shows it: %s", async (_name, orientation, topLeft, topRight) => {
    const { out } = await send(jpegWithOrientation(orientation));
    const corner = (point: [number, number]) => {
      const [x, y] = imagePoint(out!, 1, point);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(612);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(792);
      return [x < MID.x ? "left" : "right", y < MID.y ? "bottom" : "top"];
    };
    expect(corner([0, 1])).toEqual(topLeft);
    expect(corner([1, 1])).toEqual(topRight);
  });

  it("refuses a mirrored photo before the question", async () => {
    const { asked } = await send(jpegWithOrientation(2));
    expect(asked.status).toBe("blocked");
    expect(asked.reason).toContain("exactly as written");
  });
});

describe("what a filled-in PDF sends", () => {
  async function filledPdf(answer: string): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.drawText("Renewal form", { x: 72, y: 720 });
    const field = doc.getForm().createTextField("household_name");
    field.setText(answer);
    field.addToPage(page, { x: 72, y: 640, width: 300, height: 30 });
    return doc.save();
  }

  it("keeps the person's answers in a form field on the page", async () => {
    const lob = new FakeLob();
    const { gateway, documents } = await rig({ mail: new MailExecutor("test_not_real", DEFAULT_PRICING, lob.fetch) }, await filledPdf("Maria Testperson"));
    const asked = await draft(gateway, documents, letter({}, { [PAYLOAD.approvedBy]: "Ana Example" }));
    expect(asked.status).toBe("needs_approval");
    await gateway.approveAndExecute(asked.approval!.id, PERSON);
    const sent = [...lob.letters.values()][0].file;
    const out = await PDFDocument.load(sent);
    expect(out.getPageCount()).toBe(2);
    expect(drawnText(out, 1)).toContain("Maria Testperson");
  });

  it("draws the page it was given", async () => {
    const lob = new FakeLob();
    const { gateway, documents } = await rig({ mail: new MailExecutor("test_not_real", DEFAULT_PRICING, lob.fetch) }, await samplePdf(1, "plain"));
    const asked = await draft(gateway, documents, letter());
    await gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(drawnText(await PDFDocument.load([...lob.letters.values()][0].file), 1)).toContain("plain page 1");
  });

  it.each([
    ["a crop that hides part of the page", (doc: PDFDocument) => doc.getPage(0).setCropBox(0, 0, 300, 300)],
    ["a rotated page", (doc: PDFDocument) => doc.getPage(0).setRotation(degrees(90))],
  ])("refuses %s before the question, so nothing goes out that the person did not see", async (_name, change) => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]).drawText("Text outside the crop", { x: 72, y: 700 });
    change(doc);
    const lob = new FakeLob();
    const { gateway, documents } = await rig({ mail: new MailExecutor("test_not_real", DEFAULT_PRICING, lob.fetch) }, await doc.save());
    const asked = await draft(gateway, documents, letter());
    expect(asked.status).toBe("blocked");
    expect(asked.reason).toContain("Send a photo");
    expect(lob.posts).toBe(0);
  });

  it.each([
    ["far from the origin", 1000, 1000],
    ["just off the origin", 100, 100],
  ])("refuses a page whose bounds start %s, which embedding would clip", async (_name, x, y) => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.setMediaBox(x, y, 612, 792);
    page.setCropBox(x, y, 612, 792);
    page.drawText("An answer on the page", { x: x + 72, y: y + 700 });
    const lob = new FakeLob();
    const { gateway, documents } = await rig({ mail: new MailExecutor("test_not_real", DEFAULT_PRICING, lob.fetch) }, await doc.save());
    const asked = await draft(gateway, documents, letter());
    expect(asked.status).toBe("blocked");
    expect(asked.reason).toContain("Send a photo");
    expect(lob.posts).toBe(0);
  });

  it("keeps a whole legal page, which is larger than the page it goes out on", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 1008]).drawText("Near the top of a legal page", { x: 72, y: 980 });
    const lob = new FakeLob();
    const { gateway, documents } = await rig({ mail: new MailExecutor("test_not_real", DEFAULT_PRICING, lob.fetch) }, await doc.save());
    const asked = await draft(gateway, documents, letter());
    await gateway.approveAndExecute(asked.approval!.id, PERSON);
    const out = await PDFDocument.load([...lob.letters.values()][0].file);
    const forms = out.getPage(1).node.Resources()!.lookup(PDFName.of("XObject")) as PDFDict;
    const form = forms.lookup(forms.keys()[0]) as PDFStream;
    expect((form.dict.lookup(PDFName.of("BBox")) as PDFArray).asArray().map(String)).toEqual(["0", "0", "612", "1008"]);
    expect(drawnText(out, 1)).toContain("Near the top of a legal page");
  });

  it("sends a form with plain visible text and checkbox fields", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const name = doc.getForm().createTextField("household_name");
    name.setText("Maria Testperson");
    name.addToPage(page, { x: 72, y: 640, width: 300, height: 30 });
    const box = doc.getForm().createCheckBox("renewing");
    box.check();
    box.addToPage(page, { x: 72, y: 600, width: 20, height: 20 });
    const lob = new FakeLob();
    const { gateway, documents } = await rig({ mail: new MailExecutor("test_not_real", DEFAULT_PRICING, lob.fetch) }, await doc.save());
    const asked = await draft(gateway, documents, letter({}, { [PAYLOAD.approvedBy]: "Ana Example" }));
    expect(asked.status).toBe("needs_approval");
    await gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(drawnText(await PDFDocument.load([...lob.letters.values()][0].file), 1)).toContain("Maria Testperson");
  });

  const withField = async (change: (doc: PDFDocument, page: ReturnType<PDFDocument["addPage"]>) => void) => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.drawText("Renewal form", { x: 72, y: 720 });
    change(doc, page);
    return doc.save();
  };
  const hiddenField = (flag: number) => (doc: PDFDocument, page: ReturnType<PDFDocument["addPage"]>) => {
    const field = doc.getForm().createTextField("secret");
    field.setText("Not shown to the person");
    field.addToPage(page, { x: 72, y: 640, width: 300, height: 30 });
    field.acroField.getWidgets()[0].dict.set(PDFName.of("F"), doc.context.obj(flag));
  };
  const optionalContent = (d: Record<string, unknown>) => (doc: PDFDocument) => {
    const layer = doc.context.register(doc.context.obj({ Type: "OCG", Name: "Layer" }));
    doc.catalog.set(PDFName.of("OCProperties"), doc.context.obj({ OCGs: [layer], D: d } as never));
  };

  it.each<[string, (doc: PDFDocument, page: ReturnType<PDFDocument["addPage"]>) => void]>([
    ["a hidden field", hiddenField(2)],
    ["a field set not to view", hiddenField(32)],
    ["an invisible field", hiddenField(1)],
    ["a link with a visible border", (doc, page) => {
      page.node.addAnnot(doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [72, 600, 300, 640], Border: [0, 0, 2] })));
    }],
    ["a popup note", (doc, page) => {
      page.node.addAnnot(doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Popup", Rect: [72, 600, 300, 640] })));
    }],
    ["a layer that starts off", optionalContent({ OFF: [] })],
    ["layers off by default", optionalContent({ BaseState: "OFF" })],
    ["a radio group", (doc, page) => {
      const group = doc.getForm().createRadioGroup("choice");
      group.addOptionToPage("a", page, { x: 72, y: 640, width: 20, height: 20 });
    }],
    ["a dropdown", (doc, page) => {
      const list = doc.getForm().createDropdown("county");
      list.addOptions(["One"]);
      list.addToPage(page, { x: 72, y: 640, width: 200, height: 20 });
    }],
    ["a widget no field owns", (doc, page) => {
      page.node.addAnnot(doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Widget", Rect: [72, 600, 300, 640] })));
    }],
  ])("refuses %s before the question and asks for a photo", async (_name, change) => {
    const lob = new FakeLob();
    const { gateway, documents } = await rig({ mail: new MailExecutor("test_not_real", DEFAULT_PRICING, lob.fetch) }, await withField(change));
    const asked = await draft(gateway, documents, letter());
    expect(asked.status).toBe("blocked");
    expect(asked.reason).toContain("Send a photo");
    expect(lob.posts).toBe(0);
  });

  it("refuses a PDF with a note or stamp it could not carry over", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.drawText("Renewal form", { x: 72, y: 720 });
    const note = doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "FreeText", Rect: [72, 600, 300, 640], Contents: "Written on the page" }));
    page.node.addAnnot(note);
    const lob = new FakeLob();
    const { gateway, documents } = await rig({ mail: new MailExecutor("test_not_real", DEFAULT_PRICING, lob.fetch) }, await doc.save());
    const asked = await draft(gateway, documents, letter());
    expect(asked.status).toBe("blocked");
    expect(asked.reason).toContain("Send a photo");
    expect(lob.posts).toBe(0);
  });
});

describe("what the provider keeps of a fax", () => {
  it("names uploaded media and sets it to expire, without the option the provider forbids beside it", async () => {
    const telnyx = new FakeTelnyx();
    const { gateway, documents } = await rig({ fax: faxExecutor(telnyx) });
    const asked = await draft(gateway, documents, fax());
    expect((await gateway.approveAndExecute(asked.approval!.id, PERSON)).status).toBe("completed");
    expect(telnyx.mediaTtl).toBe("3600");
  });
});

describe("the provider an attempt began against", () => {
  function bootsOver(documents: MapDocumentStore, inner: () => Executor, providers: () => Partial<Record<"fax" | "mail", Executor>>) {
    const storage = openTestStorage() as never;
    ensureGatewayTables(storage);
    return (withProvider: boolean) => {
      const store = new SqlApprovalStore(storage);
      const router = new OutboundRouter(inner(), withProvider ? providers() : {}, (key) => store.getAttempt(key));
      return { store, gateway: new ActionGateway(store, router, { documents, linkCheck: async () => ({ allowed: true }) }) };
    };
  }

  it("a real fax never gets a simulated receipt when its provider goes away in simulated mode", async () => {
    const telnyx = new FakeTelnyx();
    telnyx.next = "after-recording";
    telnyx.lookupDown = true;
    const documents = new MapDocumentStore();
    documents.set("doc-1", await samplePdf());
    const log = memoryLog();
    const standIn = new InMemoryExecutor();
    const boot = bootsOver(documents, () => standIn, () => ({
      fax: new FaxExecutor({ apiKey: "not-real", connectionId: "c-1", ownNumber: OWN_NUMBER, fromNumber: "+15550100002", pricing: DEFAULT_PRICING, sendLog: log }, telnyx.fetch, 1000),
    }));
    const first = boot(true);
    const asked = await draft(first.gateway, documents, fax());
    await first.gateway.approveAndExecute(asked.approval!.id, PERSON);
    const key = asked.approval!.idempotencyKey;
    expect(first.store.getAttempt(key)?.provider).toBe("telnyx");

    const gone = boot(false);
    const later = new Date(Date.now() + 6 * 60_000);
    const recovered = await gone.gateway.recoverAttempt(key, later, later.toISOString());
    expect(recovered?.status).toBe("blocked");
    expect((await gone.gateway.approveAndExecute(asked.approval!.id, PERSON)).status).toBe("blocked");
    expect(gone.store.getAttempt(key)?.status).toBe("unknown");
    expect(gone.store.getReceiptByKey(key)).toBeNull();
    expect(standIn.calls).toHaveLength(0);

    telnyx.lookupDown = false;
    const done = await boot(true).gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(done).toMatchObject({ status: "reconciled", receipt: { simulated: false } });
    expect(telnyx.faxPosts).toBe(1);
  });

  it("an attempt begun on the stand-in stays there when a real provider appears", async () => {
    const telnyx = new FakeTelnyx();
    const documents = new MapDocumentStore();
    documents.set("doc-1", await samplePdf());
    const standIn = new InMemoryExecutor();
    standIn.failNextWithTimeout = true;
    const realCheck = standIn.check.bind(standIn);
    let down = true;
    standIn.check = async (key, person) => {
      if (down) throw new Error("not reachable");
      return realCheck(key, person);
    };
    const boot = bootsOver(documents, () => standIn, () => ({ fax: faxExecutor(telnyx) }));
    const first = boot(false);
    const asked = await draft(first.gateway, documents, fax());
    await first.gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(first.store.getAttempt(asked.approval!.idempotencyKey)?.provider).toBe("stand-in");
    down = false;
    const done = await boot(true).gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(done.receipt?.simulated).toBe(true);
    expect(telnyx.faxPosts).toBe(0);
  });
});

describe("a fax or letter attempt with no provider on record", () => {
  it.each<["fax" | "mail"]>([["fax"], ["mail"]])("%s stays unknown in simulated mode, and the stand-in never sees it", async (type) => {
    const documents = new MapDocumentStore();
    documents.set("doc-1", await samplePdf());
    const storage = openTestStorage() as never as { exec(query: string, ...bindings: unknown[]): unknown };
    ensureGatewayTables(storage as never);
    const store = new SqlApprovalStore(storage as never);
    const standIn = new InMemoryExecutor();
    standIn.failNextWithTimeout = true;
    const realCheck = standIn.check.bind(standIn);
    let down = true;
    standIn.check = async (key, person) => {
      if (down) throw new Error("not reachable");
      return realCheck(key, person);
    };
    const gateway = new ActionGateway(store, new OutboundRouter(standIn, {}, (key) => store.getAttempt(key)), { documents, linkCheck: async () => ({ allowed: true }) });
    const asked = await draft(gateway, documents, type === "fax" ? fax() : letter());
    await gateway.approveAndExecute(asked.approval!.id, PERSON);
    const key = asked.approval!.idempotencyKey;
    storage.exec("UPDATE attempts SET provider = NULL WHERE idempotency_key = ?", key);
    down = false;
    const calls = standIn.calls.length;
    const retry = await gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(retry.status).toBe("blocked");
    expect(store.getAttempt(key)?.status).toBe("unknown");
    expect(store.getReceiptByKey(key)).toBeNull();
    expect(standIn.calls).toHaveLength(calls);
  });

  it("a filing attempt on the portal is unchanged", async () => {
    const documents = new MapDocumentStore();
    const storage = openTestStorage() as never;
    ensureGatewayTables(storage);
    const store = new SqlApprovalStore(storage);
    const inner = new InMemoryExecutor();
    inner.failNextWithTimeout = true;
    const gateway = new ActionGateway(store, new OutboundRouter(inner, {}, (key) => store.getAttempt(key)), { documents, linkCheck: async () => ({ allowed: true }) });
    const asked = await gateway.requestAction({ type: "submit", recipient: "sandbox-agency", purpose: "renewal", payload: {}, idempotencyKey: "submit-1", actor: "foreground", personId: PERSON });
    const done = await gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(done.status).toBe("reconciled");
    expect(store.getAttempt("submit-1")?.provider ?? null).toBeNull();
  });
});

describe("an unconfirmed fax that never appears", () => {
  it("never schedules a lookup past the day's cutoff", async () => {
    const telnyx = new FakeTelnyx();
    telnyx.next = "before-recording";
    const { gateway, documents, store } = await rig({ fax: faxExecutor(telnyx) });
    const asked = await draft(gateway, documents, fax());
    await gateway.approveAndExecute(asked.approval!.id, PERSON);
    const key = asked.approval!.idempotencyKey;
    const since = Date.parse(store.getAttempt(key)!.lookupFailingSince!);
    const start = Date.now();
    const scansAt: number[] = [];
    for (let minutes = 5; minutes <= 2 * 24 * 60; minutes += 5) {
      const now = new Date(start + minutes * 60_000);
      const cutoff = new Date(now.getTime() - 5 * 60_000).toISOString();
      const before = telnyx.listCalls;
      for (const attempt of store.listRecoverableAttempts(cutoff, now.toISOString())) await gateway.recoverAttempt(attempt.key, now, cutoff);
      if (telnyx.listCalls > before) scansAt.push(now.getTime());
      const next = store.getAttempt(key)?.nextLookupAt;
      if (next) expect(Date.parse(next)).toBeLessThanOrEqual(since + 24 * 3600_000);
    }
    expect(Math.max(...scansAt)).toBeLessThanOrEqual(since + 24 * 3600_000 + 5 * 60_000);
    expect(store.getAttempt(key)?.nextLookupAt).toBeNull();
  }, 60_000);


  // Three days of five-minute sweeps, which takes a moment on a busy machine.
  it("backs off, stops looking after a day, is never resent, and the sweep ends", { timeout: 60_000 }, async () => {
    const telnyx = new FakeTelnyx();
    telnyx.next = "before-recording";
    const { gateway, documents, store } = await rig({ fax: faxExecutor(telnyx) });
    const asked = await draft(gateway, documents, fax());
    await gateway.approveAndExecute(asked.approval!.id, PERSON);
    const key = asked.approval!.idempotencyKey;
    const start = Date.now();
    const scansAt: number[] = [];
    for (let minutes = 5; minutes <= 3 * 24 * 60; minutes += 5) {
      const now = new Date(start + minutes * 60_000);
      const cutoff = new Date(now.getTime() - 5 * 60_000).toISOString();
      const before = telnyx.listCalls;
      for (const attempt of store.listRecoverableAttempts(cutoff, now.toISOString())) await gateway.recoverAttempt(attempt.key, now, cutoff);
      if (telnyx.listCalls > before) scansAt.push(minutes);
    }
    expect(scansAt.length).toBeGreaterThan(3);
    expect(scansAt.length).toBeLessThan(15);
    expect(scansAt[scansAt.length - 1]).toBeLessThanOrEqual(24 * 60 + 15);
    expect(telnyx.faxPosts).toBe(1);
    expect(store.getAttempt(key)?.status).toBe("unknown");
    expect(store.hasUnresolvedAttempts()).toBe(false);
    expect(store.getAttempt(key)?.nextLookupAt).toBeNull();
  });

  it("a person's own YES can still find it after the sweep stopped", async () => {
    const telnyx = new FakeTelnyx();
    telnyx.next = "lands-late";
    const { gateway, documents, store } = await rig({ fax: faxExecutor(telnyx) });
    const asked = await draft(gateway, documents, fax());
    await gateway.approveAndExecute(asked.approval!.id, PERSON);
    const key = asked.approval!.idempotencyKey;
    const dayLater = new Date(Date.now() + 25 * 3600_000);
    await gateway.approveAndExecute(asked.approval!.id, PERSON, dayLater);
    expect(store.getAttempt(key)?.nextLookupAt).toBeNull();
    telnyx.land();
    expect((await gateway.approveAndExecute(asked.approval!.id, PERSON)).status).toBe("reconciled");
    expect(telnyx.faxPosts).toBe(1);
  });

  it("a letter whose provider stays unreachable backs off the same way", async () => {
    const lob = new FakeLob();
    lob.next = "after-recording";
    lob.lookupDown = true;
    const { gateway, documents, store } = await rig({ mail: new MailExecutor("test_not_real", DEFAULT_PRICING, lob.fetch) });
    const asked = await draft(gateway, documents, letter());
    await gateway.approveAndExecute(asked.approval!.id, PERSON);
    expect(store.getAttempt(asked.approval!.idempotencyKey)?.nextLookupAt).toEqual(expect.any(String));
    lob.lookupDown = false;
    expect((await gateway.approveAndExecute(asked.approval!.id, PERSON)).status).toBe("reconciled");
  });
});

describe("Guardian checks each fax and letter", () => {
  it("runs on the draft and again on the yes, and its block stops the send", async () => {
    const telnyx = new FakeTelnyx();
    const documents = new MapDocumentStore();
    documents.set("doc-1", await samplePdf());
    const storage = openTestStorage() as never;
    ensureGatewayTables(storage);
    const store = new SqlApprovalStore(storage);
    const seen: string[] = [];
    let verdict: "pass" | "block" = "pass";
    const router = new OutboundRouter(new InMemoryExecutor(), { fax: faxExecutor(telnyx) }, (key) => store.getAttempt(key));
    const gateway = new ActionGateway(store, router, {
      documents,
      linkCheck: async () => ({ allowed: true }),
      checker: {
        check: async (input) => {
          seen.push(input.action.type);
          return { verdict, problems: verdict === "block" ? ["held"] : [] };
        },
      },
    });
    const asked = await draft(gateway, documents, fax());
    expect(seen).toEqual(["fax"]);
    verdict = "block";
    expect((await gateway.approveAndExecute(asked.approval!.id, PERSON)).status).toBe("blocked");
    expect(seen).toEqual(["fax", "fax"]);
    expect(telnyx.faxPosts).toBe(0);
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
    expect(outboundProviders(all, memoryLog()).fax).toBeDefined();
    for (const key of Object.keys(all)) {
      expect(outboundProviders({ ...all, [key]: undefined }, memoryLog()).fax).toBeUndefined();
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
