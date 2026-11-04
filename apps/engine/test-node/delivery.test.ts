/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { parseFaxEvent, parseMailEvent, verifyFaxSignature, verifyMailSignature } from "../src/gateway/delivery.js";

// Provider webhooks are believed only with a valid, fresh signature over
// the exact raw body, using each provider's documented scheme.

const NOW = Date.parse("2026-11-03T20:00:00.000Z");
const encoder = new TextEncoder();

async function mailHeaders(body: string, secret: string, timestamp: string): Promise<Headers> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${body}`));
  return new Headers({ "lob-signature": Buffer.from(mac).toString("hex"), "lob-signature-timestamp": timestamp });
}

const faxKeys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
const faxPublic = Buffer.from((await crypto.subtle.exportKey("raw", faxKeys.publicKey)) as ArrayBuffer).toString("base64");

async function faxHeaders(body: string, seconds: number, keys = faxKeys): Promise<Headers> {
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, keys.privateKey, encoder.encode(`${seconds}|${body}`));
  return new Headers({ "telnyx-signature-ed25519": Buffer.from(sig).toString("base64"), "telnyx-timestamp": String(seconds) });
}

describe("mail webhook signature", () => {
  const body = '{"id":"evt_1"}';
  const at = new Date(NOW).toISOString();

  it("accepts the exact body under the right secret", async () => {
    expect(await verifyMailSignature(body, await mailHeaders(body, "s3", at), "s3", NOW)).toBe(true);
  });

  it("refuses a changed body, a wrong secret, an old timestamp and missing headers", async () => {
    const headers = await mailHeaders(body, "s3", at);
    expect(await verifyMailSignature(`${body} `, headers, "s3", NOW)).toBe(false);
    expect(await verifyMailSignature(body, headers, "other", NOW)).toBe(false);
    expect(await verifyMailSignature(body, headers, "s3", NOW + 6 * 60_000)).toBe(false);
    expect(await verifyMailSignature(body, new Headers(), "s3", NOW)).toBe(false);
  });
});

describe("fax webhook signature", () => {
  const body = '{"data":{}}';
  const seconds = NOW / 1000;

  it("accepts the exact body from the right key", async () => {
    expect(await verifyFaxSignature(body, await faxHeaders(body, seconds), faxPublic, NOW)).toBe(true);
  });

  it("refuses a changed body, another key, an old timestamp and garbage", async () => {
    const headers = await faxHeaders(body, seconds);
    expect(await verifyFaxSignature(`${body} `, headers, faxPublic, NOW)).toBe(false);
    const other = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    expect(await verifyFaxSignature(body, await faxHeaders(body, seconds, other), faxPublic, NOW)).toBe(false);
    expect(await verifyFaxSignature(body, headers, faxPublic, NOW + 6 * 60_000)).toBe(false);
    expect(await verifyFaxSignature(body, new Headers({ "telnyx-signature-ed25519": "!!", "telnyx-timestamp": String(seconds) }), faxPublic, NOW)).toBe(false);
  });
});

describe("reading events", () => {
  it("reads a letter's ID and status, and never takes a person from its metadata", () => {
    const event = parseMailEvent(JSON.stringify({ id: "evt_1", event_type: { id: "letter.mailed" }, body: { id: "ltr_1", metadata: { mano_person: "REDACTED" } } }));
    expect(event).toEqual({ channel: "mail", externalId: "ltr_1", status: "letter.mailed", eventId: "evt_1" });
  });

  it("reads our fax's status and person from its client state", () => {
    const client_state = btoa(JSON.stringify({ key: "k", personId: "maria" }));
    const event = parseFaxEvent(JSON.stringify({ data: { id: "evt_2", event_type: "fax.delivered", payload: { fax_id: "fax_1", client_state } } }));
    expect(event).toEqual({ personId: "maria", channel: "fax", externalId: "fax_1", status: "fax.delivered", eventId: "evt_2" });
  });

  it("drops events that are not ours", () => {
    expect(parseMailEvent(JSON.stringify({ id: "evt", event_type: { id: "x" }, body: { id: "psc_1", metadata: {} } }))).toBeNull();
    expect(parseMailEvent("not json")).toBeNull();
    expect(parseFaxEvent(JSON.stringify({ data: { id: "evt", event_type: "x", payload: { fax_id: "f" } } }))).toBeNull();
    expect(parseFaxEvent("not json")).toBeNull();
  });
});
