import { SELF, env as testEnv, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { mintHandleGrant, personIdForHandle } from "@mano/protocol";
import { DEFAULT_PRICING, MailExecutor, PAYLOAD, SqlFaxSendLog, rememberDeliveryRoute, verifyFaxSignature, withOutboundPrice, type ActionRequest } from "../src/gateway/index.js";
import { bytesToBase64, sha256Hex } from "../src/hash.js";

// Faxes and letters in the real runtime: the worker route, the person's
// Durable Object, the PDF library and web crypto all running in workerd.
// The provider stays off here, so the stand-in labels receipts simulated.

// Must match the bindings in vitest.config.ts.
const AGENT_TOKEN = "test-agent-token-not-real";
const CHANNELS_TOKEN = "test-channels-token-not-real";
const GRANT_SECRET = "test-handle-grant-secret-not-real";
const WEBHOOK_SECRET = "test-mail-webhook-secret-not-real";

function rig(tag: string) {
  const handle = Array.from(new TextEncoder().encode(tag.padEnd(32, "0").slice(0, 32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const person = personIdForHandle(handle);
  const call = async (method: string, path: string, body: unknown, token = AGENT_TOKEN) =>
    SELF.fetch(`https://engine.test/api/persons/${person}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "x-mano-handle-grant": await mintHandleGrant(handle, GRANT_SECRET),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  return { person, call };
}

async function getHeaders(tag: string): Promise<RequestInit> {
  const handle = Array.from(new TextEncoder().encode(tag.padEnd(32, "0").slice(0, 32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return { headers: { authorization: `Bearer ${AGENT_TOKEN}`, "x-mano-handle-grant": await mintHandleGrant(handle, GRANT_SECRET) } };
}

async function samplePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]).drawText("Synthetic renewal letter", { x: 72, y: 700 });
  return doc.save();
}

const LETTER = {
  type: "mail",
  recipient: "mano-practice-mailbox",
  purpose: "Maria's food benefits renewal",
  actor: "foreground",
  generation: 0,
  payload: {
    [PAYLOAD.mailTo]: "State Benefits Office, 100 Practice Way, Sacramento, CA 95814",
    [PAYLOAD.returnAddress]: "Maria Testperson, 1 Example St, Sacramento, CA 95814",
    [PAYLOAD.approvedBy]: "Maria Testperson",
    [PAYLOAD.price]: "$0.01",
  },
};

describe("a letter through Engine", () => {
  it("freezes Engine's price over the caller's, and the yes sends it", async () => {
    const { call } = rig("outbound-letter");
    const pdf = await samplePdf();
    const stored = await call("POST", "/documents", { id: "g0t1i0-letter", name: "letter", contentB64: bytesToBase64(pdf), generation: 0 }, CHANNELS_TOKEN);
    expect(stored.status).toBe(200);
    const asked = (await (await call("POST", "/action", { ...LETTER, documentId: "g0t1i0-letter", idempotencyKey: "letter-1" })).json()) as {
      status: string;
      approval: { id: string; requestJson: string; documentHash: string };
    };
    expect(asked.status).toBe("needs_approval");
    const frozen = JSON.parse(asked.approval.requestJson);
    expect(frozen.payload[PAYLOAD.price]).toBe("$1.05, not charged in practice");
    expect(asked.approval.documentHash).toBe(await sha256Hex(pdf));
    const done = (await (await call("POST", `/approvals/${asked.approval.id}/approve`, {})).json()) as {
      status: string;
      receipt: { actionType: string; simulated: boolean };
    };
    expect(done.status).toBe("completed");
    expect(done.receipt).toMatchObject({ actionType: "mail", simulated: true });
  });
});

describe("replaying a sent letter", () => {
  it("answers the saved receipt without reading storage, when the first request left pricing to Engine", async () => {
    const { person, call } = rig("outbound-replay");
    const pdf = await samplePdf();
    await call("POST", "/documents", { id: "g0t1i0-replay", name: "letter", contentB64: bytesToBase64(pdf), generation: 0 }, CHANNELS_TOKEN);
    const unpriced = {
      ...LETTER,
      payload: { [PAYLOAD.mailTo]: LETTER.payload[PAYLOAD.mailTo], [PAYLOAD.returnAddress]: LETTER.payload[PAYLOAD.returnAddress], [PAYLOAD.approvedBy]: LETTER.payload[PAYLOAD.approvedBy] },
      documentId: "g0t1i0-replay",
      idempotencyKey: "replay-1",
    };
    const asked = (await (await call("POST", "/action", unpriced)).json()) as { approval: { id: string } };
    const first = (await (await call("POST", `/approvals/${asked.approval.id}/approve`, {})).json()) as { status: string; receipt: { id: string } };
    expect(first.status).toBe("completed");

    const stub = testEnv.PERSON_AGENT.get(testEnv.PERSON_AGENT.idFromName(person));
    await runInDurableObject(stub, async (agent) => {
      (agent as unknown as { documentBytes: () => Promise<never> }).documentBytes = async () => {
        throw new Error("storage is down");
      };
    });
    const replay = (await (await call("POST", "/action", unpriced)).json()) as { status: string; receipt?: { id: string }; reason?: string };
    expect(replay.reason).toBeUndefined();
    expect(replay.status).toBe("completed");
    expect(replay.receipt?.id).toBe(first.receipt.id);
  });

  it("tells the agent when Mano has stopped checking on a send", async () => {
    const { person, call } = rig("outbound-ended");
    await call("POST", "/documents", { id: "g0t1i0-ended", name: "letter", contentB64: bytesToBase64(await samplePdf()), generation: 0 }, CHANNELS_TOKEN);
    const asked = (await (await call("POST", "/action", { ...LETTER, documentId: "g0t1i0-ended", idempotencyKey: "ended-1" })).json()) as { approval: { id: string } };
    await call("POST", `/approvals/${asked.approval.id}/approve`, {});
    const stub = testEnv.PERSON_AGENT.get(testEnv.PERSON_AGENT.idFromName(person));
    await runInDurableObject(stub, async (_agent, state) => {
      state.storage.sql.exec("UPDATE attempts SET status = 'unknown', lookup_failing_since = '2026-11-03T10:00:00.000Z', next_lookup_at = NULL");
    });
    const res = await SELF.fetch(`https://engine.test/api/persons/${person}/approvals`, await getHeaders("outbound-ended"));
    const { approvals } = (await res.json()) as { approvals: { id: string; outcome: { attempt: string; lookupsEnded: boolean } }[] };
    expect(approvals.find((a) => a.id === asked.approval.id)?.outcome).toMatchObject({ attempt: "unknown", lookupsEnded: true });
  });

  it("still refuses the same key with different content", async () => {
    const { call } = rig("outbound-reuse");
    await call("POST", "/documents", { id: "g0t1i0-reuse", name: "letter", contentB64: bytesToBase64(await samplePdf()), generation: 0 }, CHANNELS_TOKEN);
    const request = { ...LETTER, documentId: "g0t1i0-reuse", idempotencyKey: "reuse-1" };
    const asked = (await (await call("POST", "/action", request)).json()) as { approval: { id: string } };
    await call("POST", `/approvals/${asked.approval.id}/approve`, {});
    const other = (await (await call("POST", "/action", { ...request, purpose: "Something else" })).json()) as { status: string; reason: string };
    expect(other.status).toBe("blocked");
    expect(other.reason).toContain("different content");
  });
});

describe("the provider path in workerd", () => {
  it("renders the PDF and posts the form with its idempotency key", async () => {
    const pdf = await samplePdf();
    const raw = {
      type: "mail",
      recipient: "mano-practice-mailbox",
      purpose: "renewal",
      documentId: "doc",
      payload: LETTER.payload,
      idempotencyKey: "workerd-1",
      actor: "foreground",
      personId: "maria-synthetic",
    };
    const priced = (await withOutboundPrice(raw, async () => pdf, DEFAULT_PRICING, () => null)) as ActionRequest;
    const sent: { key: string | null; file: Blob }[] = [];
    const fakeFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ key: new Headers(init?.headers).get("idempotency-key"), file: (init?.body as FormData).get("file") as unknown as Blob });
      return Response.json({ id: "ltr_workerd" });
    }) as typeof fetch;
    const executor = new MailExecutor("test_not_real", DEFAULT_PRICING, fakeFetch);
    const request: ActionRequest = {
      ...priced,
      answeredBy: "maria-synthetic",
      document: { bytesB64: bytesToBase64(pdf), hash: await sha256Hex(pdf) },
    };
    expect(await executor.refuse(request)).toBeNull();
    expect(await executor.execute(request)).toEqual({ externalId: "ltr_workerd", simulated: true });
    expect(sent[0].key).toMatch(/^mano-[0-9a-f]{64}$/);
    const out = await PDFDocument.load(await sent[0].file.arrayBuffer());
    expect(out.getPageCount()).toBe(2);
  });

  it("keeps which faxes went out in the person's own SQLite", async () => {
    const { person, call } = rig("outbound-fax-log");
    await call("POST", "/documents", { id: "g0t1i0-faxlog", name: "letter", contentB64: bytesToBase64(await samplePdf()), generation: 0 }, CHANNELS_TOKEN);
    const stub = testEnv.PERSON_AGENT.get(testEnv.PERSON_AGENT.idFromName(person));
    const read = await runInDurableObject(stub, async (_agent, state) => {
      const log = new SqlFaxSendLog(state.storage.sql);
      const claims = [log.claim("key"), log.claim("key")];
      return [...claims, log.wasSent("key"), log.wasSent("other")];
    });
    expect(read).toEqual([true, false, true, false]);
  });

  it("verifies an Ed25519 fax signature with workerd's web crypto", async () => {
    const keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const publicKey = bytesToBase64(new Uint8Array((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer));
    const seconds = Math.floor(Date.now() / 1000);
    const body = '{"data":{}}';
    const signature = await crypto.subtle.sign({ name: "Ed25519" }, keys.privateKey, new TextEncoder().encode(`${seconds}|${body}`));
    const headers = new Headers({ "telnyx-signature-ed25519": bytesToBase64(new Uint8Array(signature)), "telnyx-timestamp": String(seconds) });
    expect(await verifyFaxSignature(body, headers, publicKey)).toBe(true);
    expect(await verifyFaxSignature(`${body} `, headers, publicKey)).toBe(false);
  });
});

describe("delivery webhooks", () => {
  async function signed(body: string, secret = WEBHOOK_SECRET): Promise<Record<string, string>> {
    const timestamp = new Date().toISOString();
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`));
    const hex = Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
    return { "lob-signature": hex, "lob-signature-timestamp": timestamp };
  }

  const post = (path: string, body: string, headers: Record<string, string> = {}) =>
    SELF.fetch(`https://engine.test${path}`, { method: "POST", body, headers });

  // What the provider sends by default: metadata redacted, the letter's own ID not.
  const redacted = (eventId: string, letterId: string) =>
    JSON.stringify({ id: eventId, event_type: { id: "letter.mailed" }, body: { id: letterId, description: "REDACTED", metadata: { mano_person: "REDACTED" } } });

  const eventsOf = (person: string) =>
    runInDurableObject(testEnv.PERSON_AGENT.get(testEnv.PERSON_AGENT.idFromName(person)), async (_agent, state) =>
      state.storage.sql.exec("SELECT external_id, status FROM delivery_events").toArray(),
    );

  it("places a signed event by its letter ID once, with its metadata redacted, and a bad signature changes nothing", async () => {
    const { person, call } = rig("outbound-webhook");
    expect((await call("POST", "/documents", { id: "g0t1i0-webhook", name: "letter", contentB64: bytesToBase64(await samplePdf()), generation: 0 }, CHANNELS_TOKEN)).status).toBe(200);
    await rememberDeliveryRoute(testEnv.FILES as R2Bucket, "ltr_webhook1", person);
    const body = redacted("evt_1", "ltr_webhook1");
    expect((await post("/webhooks/mail", body, await signed(body, "wrong-secret"))).status).toBe(401);
    expect((await post("/webhooks/mail", body)).status).toBe(401);
    expect((await post("/webhooks/mail", body, await signed(body))).status).toBe(204);
    expect((await post("/webhooks/mail", body, await signed(body))).status).toBe(204);
    expect(await eventsOf(person)).toEqual([{ external_id: "ltr_webhook1", status: "letter.mailed" }]);
    expect(await eventsOf("REDACTED")).toEqual([]);
  });

  it("does not acknowledge an event it could not place, so the provider sends it again", async () => {
    const { person, call } = rig("outbound-webhook-late");
    await call("POST", "/documents", { id: "g0t1i0-late", name: "letter", contentB64: bytesToBase64(await samplePdf()), generation: 0 }, CHANNELS_TOKEN);
    const body = redacted("evt_3", "ltr_notyet1");
    expect((await post("/webhooks/mail", body, await signed(body))).status).toBe(404);
    await rememberDeliveryRoute(testEnv.FILES as R2Bucket, "ltr_notyet1", person);
    expect((await post("/webhooks/mail", body, await signed(body))).status).toBe(204);
    expect(await eventsOf(person)).toEqual([{ external_id: "ltr_notyet1", status: "letter.mailed" }]);
  });

  it("a report for a person with no record creates none, and is not acknowledged", async () => {
    const { person } = rig("outbound-webhook-gone");
    await rememberDeliveryRoute(testEnv.FILES as R2Bucket, "ltr_gone1", person);
    const body = redacted("evt_2", "ltr_gone1");
    expect((await post("/webhooks/mail", body, await signed(body))).status).toBe(404);
    expect(await eventsOf(person)).toEqual([]);
  });

  it("an event with no letter in it is refused", async () => {
    const body = JSON.stringify({ id: "evt_4", event_type: { id: "postcard.mailed" }, body: { id: "psc_1" } });
    expect((await post("/webhooks/mail", body, await signed(body))).status).toBe(422);
  });

  it("stays closed with no key to verify against", async () => {
    expect((await post("/webhooks/fax", "{}")).status).toBe(404);
  });
});
