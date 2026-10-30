import { describe, expect, it } from "vitest";
import { verifyHandleGrant } from "@mano/protocol";

import {
  AgentResponder,
  PHOTO_UNREAD_TEXT,
  StandInResponder,
  attachmentNote,
  saveDocumentInEngine,
} from "../src/index.js";

// A photo texted to the line: Channels stores it in the person's Engine
// documents, sends the agent its reference with the turn, and never
// promises to read it later. When the agent cannot answer, the reply says
// the photo was not read.
const HANDLE = "a".repeat(64);
const PHOTO = { id: "g0t1i0-abc123abc123", mimeType: "image/jpeg" };

function agent(fetchFn: typeof fetch, fallback = new StandInResponder(["fallback reply"])) {
  return new AgentResponder({
    agentUrl: "https://agent.example",
    secret: "secret",
    grantSecret: "grant-secret",
    handleHash: HANDLE,
    fallback,
    timeoutMs: 1000,
    fetchFn,
  });
}

describe("texted photos", () => {
  it("the agent turn carries the stored photo's reference, and the agent reads photos", async () => {
    const seen: Record<string, unknown>[] = [];
    const responder = agent((async (_url: string, init: RequestInit) => {
      seen.push(JSON.parse(String(init.body)));
      return Response.json({ status: "replied", text: "This is your renewal letter." });
    }) as typeof fetch);
    expect(responder.readsPhotos).toBe(true);
    const result = await responder.respond({
      texts: [],
      attachmentCount: 1,
      documents: [PHOTO],
      turnKey: { generation: 0, turn: 1 },
      receivedAtMs: 1_761_777_000_000,
    });
    expect(seen[0]).toMatchObject({ texts: [], attachmentCount: 1, documents: [PHOTO] });
    expect(result.text).toBe("This is your renewal letter.");
  });

  it("a photo-only turn the agent could not answer says the photo was not read, without the plain model", async () => {
    const fallback = new StandInResponder(["fallback reply"]);
    const result = await agent((async () => new Response("down", { status: 503 })) as typeof fetch, fallback).respond({
      texts: [],
      attachmentCount: 1,
      documents: [PHOTO],
      turnKey: { generation: 0, turn: 1 },
      receivedAtMs: 1_761_777_000_000,
    });
    expect(result.text).toBe(PHOTO_UNREAD_TEXT);
    expect(fallback.prompts).toHaveLength(0);
  });

  it("the plain model is told the photo was not read, never that it will be", () => {
    const note = attachmentNote(1);
    expect(note).not.toMatch(/will be read|read separately/i);
    expect(note).toMatch(/not read/i);
    expect((new StandInResponder() as { readsPhotos?: boolean }).readsPhotos ?? false).toBe(false);
  });

  it("stores a photo in the person's Engine documents with Channels' token, a grant and its generation", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const ok = await saveDocumentInEngine({
      engineUrl: "https://engine.example/",
      channelsToken: "channels-token",
      grantSecret: "grant-secret-for-tests",
      handleHash: HANDLE,
      generation: 2,
      id: PHOTO.id,
      name: `${PHOTO.id}.jpg`,
      bytes: new TextEncoder().encode("synthetic-photo-bytes"),
      fetchFn: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return Response.json({ id: PHOTO.id, hash: "h" });
      }) as typeof fetch,
    });
    expect(ok).toBe(true);
    expect(seen[0].url).toBe(`https://engine.example/api/persons/handle-${HANDLE}/documents`);
    expect(seen[0].init.method).toBe("POST");
    const body = JSON.parse(String(seen[0].init.body));
    expect(body).toMatchObject({ id: PHOTO.id, name: `${PHOTO.id}.jpg`, generation: 2 });
    expect(atob(body.contentB64)).toBe("synthetic-photo-bytes");
    const headers = seen[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer channels-token");
    expect((await verifyHandleGrant(headers["x-mano-handle-grant"], "grant-secret-for-tests"))?.handle).toBe(HANDLE);
  });

  it("an upload Engine refused is not stored", async () => {
    const refused = await saveDocumentInEngine({
      engineUrl: "https://e",
      channelsToken: "t",
      grantSecret: "g",
      handleHash: HANDLE,
      generation: 0,
      id: PHOTO.id,
      name: "p.jpg",
      bytes: new Uint8Array([1]),
      fetchFn: (async () => new Response("stale", { status: 409 })) as typeof fetch,
    });
    expect(refused).toBe(false);
  });
});
