/// <reference types="node" />
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { ActionGateway, MapDocumentStore, MemoryApprovalStore } from "../src/gateway/gateway.js";
import { InMemoryExecutor } from "../src/gateway/executors.js";
import { MailExecutor } from "../src/gateway/mail.js";
import { DEFAULT_PRICING, MAIL_RECIPIENT, PAYLOAD, downstreamKey, withOutboundPrice } from "../src/gateway/outbound.js";
import { OutboundRouter } from "../src/gateway/outbound-router.js";

// One real letter in the mail provider's test mode, where nothing is
// printed or mailed. Off unless asked for. To run it, with the key in the
// environment:
//   MANO_LIVE_OUTBOUND=1 vitest run --config vitest.node.config.ts test-node/outbound-live.test.ts
// MANO_LIVE_OUTPUT names a file for the rendered letter. The first send is
// cut off after the provider answers, as a timeout would, so the gateway
// has to reconcile, and only one letter may exist at the end.
const live = process.env.MANO_LIVE_OUTBOUND === "1" && Boolean(process.env.LOB_TEST_API_KEY);
const API = "https://api.lob.com/v1";

describe.runIf(live)("a real test mode letter", () => {
  it("sends one letter through the gateway and survives a timeout with no duplicate", { timeout: 180_000 }, async () => {
    const apiKey = process.env.LOB_TEST_API_KEY!;
    const auth = { authorization: `Basic ${btoa(`${apiKey}:`)}` };
    const person = "maria-synthetic";
    const idempotencyKey = `lap-860-live-${crypto.randomUUID()}`;
    const source = await PDFDocument.create();
    source.addPage([612, 792]).drawText("Synthetic renewal letter for Maria Testperson. No real person.", { x: 72, y: 700, size: 12 });
    const pdf = await source.save();

    let posts = 0;
    const cutOffFirstSend = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await fetch(input, init);
      if (init?.method === "POST" && ++posts === 1) {
        await res.arrayBuffer();
        const err = new Error("cut off after the provider answered");
        err.name = "AbortError";
        throw err;
      }
      return res;
    }) as typeof fetch;

    const store = new MemoryApprovalStore();
    const executor = new MailExecutor(apiKey, DEFAULT_PRICING, cutOffFirstSend, 60_000);
    const documents = new MapDocumentStore();
    documents.set("doc-1", pdf);
    const gateway = new ActionGateway(
      store,
      new OutboundRouter(new InMemoryExecutor(), { mail: executor }, (key) => store.getAttempt(key)?.actionType ?? null),
      { documents, linkCheck: async () => ({ allowed: true }) },
    );
    const priced = await withOutboundPrice(
      {
        type: "mail",
        recipient: MAIL_RECIPIENT,
        purpose: "Maria's food benefits renewal, synthetic test",
        documentId: "doc-1",
        idempotencyKey,
        actor: "foreground",
        personId: person,
        payload: {
          [PAYLOAD.mailTo]: "State Benefits Office, 185 Berry St, San Francisco, CA 94107",
          [PAYLOAD.returnAddress]: "Maria Testperson, 210 King St, San Francisco, CA 94107",
          [PAYLOAD.approvedBy]: "Maria Testperson",
        },
      },
      (id) => documents.getBytes(id),
      DEFAULT_PRICING,
    );
    const asked = await gateway.requestAction(priced);
    expect(asked.status).toBe("needs_approval");
    console.log(`[live] price shown before the yes: ${JSON.parse(asked.approval!.requestJson).payload[PAYLOAD.price]}`);

    let result = await gateway.approveAndExecute(asked.approval!.id, person);
    console.log(`[live] after the cut-off send: ${result.status}`);
    // The provider's list can lag. Its idempotency key makes a retry safe.
    for (let tries = 0; tries < 5 && result.status === "blocked"; tries++) {
      await new Promise((r) => setTimeout(r, 3000));
      result = await gateway.approveAndExecute(asked.approval!.id, person);
      console.log(`[live] retry: ${result.status}`);
    }
    expect(["reconciled", "completed"]).toContain(result.status);
    const letterId = result.receipt!.externalId;
    expect(letterId).toMatch(/^ltr_/);
    expect(result.receipt!.simulated).toBe(true);
    console.log(`[live] letter ${letterId}, sends attempted ${posts}, receipt ${result.status}`);

    const key = await downstreamKey(person, idempotencyKey);
    let listed: { id: string }[] = [];
    for (let tries = 0; tries < 10 && listed.length === 0; tries++) {
      if (tries > 0) await new Promise((r) => setTimeout(r, 3000));
      const query = new URLSearchParams({ "metadata[mano_key]": key, limit: "10" });
      listed = ((await (await fetch(`${API}/letters?${query}`, { headers: auth })).json()) as { data: { id: string }[] }).data;
    }
    expect(listed.map((l) => l.id)).toEqual([letterId]);
    console.log(`[live] the provider lists exactly one letter under this key: ${listed[0].id}`);
    expect(await executor.check(idempotencyKey, person)).toEqual({ found: true, externalId: letterId, simulated: true });

    const letter = (await (await fetch(`${API}/letters/${letterId}`, { headers: auth })).json()) as { url?: string; to?: { name?: string } };
    expect(letter.to?.name?.toLowerCase()).toBe("state benefits office");
    if (process.env.MANO_LIVE_OUTPUT && letter.url) {
      for (let tries = 0; tries < 20; tries++) {
        const rendered = await fetch(letter.url);
        if (rendered.ok) {
          writeFileSync(process.env.MANO_LIVE_OUTPUT, Buffer.from(await rendered.arrayBuffer()));
          console.log(`[live] rendered letter saved`);
          break;
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  });
});
