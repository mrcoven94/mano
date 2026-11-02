import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintHandleGrant, personIdForHandle } from "@mano/protocol";

// The person's documents as Engine lists them to the agent: every file
// Channels stored for this conversation, newest first, with when it
// arrived, what its bytes are, what Mail found it to be, and a plain
// label Mano can show the person.

// Must match the bindings in vitest.config.ts.
const AGENT_TOKEN = "test-agent-token-not-real";
const CHANNELS_TOKEN = "test-channels-token-not-real";
const GRANT_SECRET = "test-handle-grant-secret-not-real";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 4, 5, 6];
const PDF = [...new TextEncoder().encode("%PDF-1.4 synthetic")];
const HEIC = [0, 0, 0, 24, ...new TextEncoder().encode("ftypheic synthetic")];

interface Listed {
  id: string;
  kind: string | null;
  mediaType: string | null;
  receivedAt: string;
  label: string;
  generation: number;
  sizeBytes: number | null;
  filing: string;
}

function handle(tag: string): string {
  return Array.from(new TextEncoder().encode(tag.padEnd(32, "0").slice(0, 32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function call(handleHash: string, method: string, path: string, body: unknown, token: string, onPerson = handleHash) {
  const grant = await mintHandleGrant(handleHash, GRANT_SECRET);
  return SELF.fetch(`https://engine.test/api/persons/${personIdForHandle(onPerson)}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "x-mano-handle-grant": grant, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function b64(bytes: ArrayLike<number>): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...Array.prototype.slice.call(bytes, i, i + 0x8000));
  return btoa(out);
}

const upload = (h: string, id: string, bytes: ArrayLike<number>, generation = 0) =>
  call(h, "POST", "/documents", { id, name: id, contentB64: b64(bytes), generation }, CHANNELS_TOKEN);

async function list(h: string): Promise<Listed[]> {
  const res = await call(h, "GET", "/documents", undefined, AGENT_TOKEN);
  expect(res.status).toBe(200);
  return ((await res.json()) as { documents: Listed[] }).documents;
}

const SENT_ON = /^the (photo|letter|PDF|file) you sent on (January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}$/;

describe("the person's document list", () => {
  it("lists every stored document newest first, with when it arrived, its media type and a plain label", async () => {
    const h = handle("list-order");
    for (const [id, bytes] of [["g0t1i0-first1", PNG], ["g0t2i0-second", PDF], ["g0t3i0-third1", HEIC], ["g0t4i0-fourth", JPEG]] as const) {
      expect((await upload(h, id, [...bytes])).status).toBe(200);
    }
    const docs = await list(h);
    expect(docs.map((d) => [d.id, d.mediaType, d.kind, d.generation])).toEqual([
      ["g0t4i0-fourth", "image/jpeg", null, 0],
      ["g0t3i0-third1", null, null, 0],
      ["g0t2i0-second", "application/pdf", null, 0],
      ["g0t1i0-first1", "image/png", null, 0],
    ]);
    for (const d of docs) {
      expect(Math.abs(Date.now() - Date.parse(d.receivedAt))).toBeLessThan(60_000);
      expect(d.label).toMatch(SENT_ON);
    }
    expect(docs.map((d) => d.label.split(" ")[1])).toEqual(["photo", "file", "PDF", "photo"]);

    // A retried upload is the same document, received when it first arrived.
    expect((await upload(h, "g0t1i0-first1", [...PNG])).status).toBe(200);
    expect(await list(h)).toEqual(docs);
  });

  // Review of PR 101: Engine takes uploads up to 10 MB and the portal
  // at most SANDBOX_MAX_UPLOAD_BYTES (wrangler.toml), so the list says
  // which documents the configured executor could file.
  it("records each document's size and says whether the configured executor could file it", async () => {
    const h = handle("list-fileable");
    const big = new Uint8Array(6 * 1024 * 1024);
    big.set(PNG);
    expect((await upload(h, "g0t1i0-pdf001", PDF)).status).toBe(200);
    expect((await upload(h, "g0t2i0-heic01", HEIC)).status).toBe(200);
    expect((await upload(h, "g0t3i0-bigpng", big)).status).toBe(200);
    expect((await list(h)).map((d) => [d.id, d.sizeBytes, d.filing])).toEqual([
      ["g0t3i0-bigpng", big.length, "too_large"],
      ["g0t2i0-heic01", HEIC.length, "wrong_type"],
      ["g0t1i0-pdf001", PDF.length, "fileable"],
    ]);
  });

  it("Mail's mark names a photo a letter; other kinds, unknown IDs and other services are refused", async () => {
    const h = handle("list-mark");
    expect((await upload(h, "g0t1i0-letter", [...JPEG])).status).toBe(200);
    const mark = (id: string, body: unknown, token = AGENT_TOKEN) => call(h, "PATCH", `/documents/${id}`, body, token);

    expect((await mark("g0t1i0-letter", { kind: "letter", generation: 0 })).status).toBe(200);
    const [doc] = await list(h);
    expect(doc.kind).toBe("letter");
    expect(doc.label).toMatch(/^the letter you sent on /);
    // Marking again changes nothing.
    expect((await mark("g0t1i0-letter", { kind: "letter", generation: 0 })).status).toBe(200);
    expect(await list(h)).toEqual([doc]);

    expect((await mark("g0t1i0-letter", { kind: "receipt", generation: 0 })).status).toBe(400);
    expect((await mark("g0t1i0-letter", { kind: "letter" })).status).toBe(400);
    expect((await mark("g0t9i0-nothere", { kind: "letter", generation: 0 })).status).toBe(404);
    expect((await mark("g0t1i0-letter", { kind: "letter", generation: 0 }, CHANNELS_TOKEN)).status).toBe(403);
    expect((await call(h, "GET", "/documents", undefined, CHANNELS_TOKEN)).status).toBe(403);
  });

  it("a deleted conversation's documents are gone from the list, and a mark prepared before the delete is refused", async () => {
    const h = handle("list-delete");
    expect((await upload(h, "g0t1i0-before", [...PNG])).status).toBe(200);
    expect(await list(h)).toHaveLength(1);
    expect((await call(h, "DELETE", "/conversation", { generation: 1 }, CHANNELS_TOKEN)).status).toBe(200);
    expect(await list(h)).toEqual([]);
    expect((await call(h, "PATCH", "/documents/g0t1i0-before", { kind: "letter", generation: 0 }, AGENT_TOKEN)).status).toBe(409);

    expect((await upload(h, "g1t1i0-after1", [...JPEG], 1)).status).toBe(200);
    expect((await list(h)).map((d) => [d.id, d.generation])).toEqual([["g1t1i0-after1", 1]]);
  });

  it("another person's documents are never listed, and one person's grant cannot read another's list", async () => {
    const maria = handle("list-maria");
    const other = handle("list-other");
    expect((await upload(other, "g0t1i0-theirs", [...PNG])).status).toBe(200);
    expect((await upload(maria, "g0t1i0-hers01", [...PNG])).status).toBe(200);
    expect((await list(maria)).map((d) => d.id)).toEqual(["g0t1i0-hers01"]);
    expect((await call(maria, "GET", "/documents", undefined, AGENT_TOKEN, other)).status).toBe(403);
    expect((await call(maria, "PATCH", "/documents/g0t1i0-theirs", { kind: "letter", generation: 0 }, AGENT_TOKEN, other)).status).toBe(403);
  });
});
