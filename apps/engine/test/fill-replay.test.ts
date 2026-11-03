import { SELF, env as testEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintHandleGrant, personIdForHandle } from "@mano/protocol";
import { mintSessionToken } from "../src/auth.js";
import { documentAad, encryptForPerson } from "../src/crypto.js";
import { getDocumentBytes } from "../src/files.js";
import { linkKey } from "../src/fill-replay.js";

// A fill's replay: the agent binds the screens of a fill to the approval
// it produced, Engine stores them encrypted for the person, and a link
// only the person's thread carries opens a page that asks the approval
// again on every view.

// Must match the bindings in vitest.config.ts.
const AGENT_TOKEN = "test-agent-token-not-real";
const CHANNELS_TOKEN = "test-channels-token-not-real";
const GRANT_SECRET = "test-handle-grant-secret-not-real";
const SESSION_SECRET = "test-session-secret-not-real";
const KEK = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const files = () => testEnv.FILES as R2Bucket;

function handle(tag: string): string {
  return Array.from(new TextEncoder().encode(tag.padEnd(32, "0").slice(0, 32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function call(h: string, method: string, path: string, body?: unknown, token = AGENT_TOKEN) {
  return SELF.fetch(`https://engine.test/api/persons/${personIdForHandle(h)}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "x-mano-handle-grant": await mintHandleGrant(h, GRANT_SECRET), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// A PNG signature, its header for a 1280x800 screen, and a marker byte:
// what each step's screenshot looks like here.
const png = (marker: number) =>
  new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 5, 0, 0, 0, 3, 32, 8, 6, 0, 0, 0, 0, 0, 0, 0, marker]);
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const LABELS = { fullName: "Full legal name", householdSize: "People in household" };
const replayBody = (markers = [1, 2, 3], generation = 0) => ({
  generation,
  labels: LABELS,
  steps: markers.map((m, i) => ({
    caption: i === 0 ? "Mano opened the form." : `Mano filled in step ${i}.`,
    pngB64: b64(png(m)),
    ...(i === 0 ? {} : { focus: { x: 640, y: i % 2 ? 40 : 500 } }),
  })),
});

async function storeProof(h: string, text = "synthetic pay stub v1"): Promise<string> {
  const id = `proof-${crypto.randomUUID().slice(0, 8)}`;
  const res = await call(h, "POST", "/documents", { id, name: "stub.pdf", contentB64: btoa(text), generation: 0 }, CHANNELS_TOKEN);
  expect(res.status).toBe(200);
  return id;
}

async function turn(h: string, turnId: string) {
  expect((await call(h, "POST", "/turns", { turnId, receivedAt: new Date().toISOString(), generation: 0 })).status).toBeLessThan(300);
}

async function propose(h: string, opts: { turnId?: string; documentId?: string; size?: string; recipient?: string } = {}): Promise<string> {
  const res = await call(h, "POST", "/action", {
    type: "submit",
    recipient: opts.recipient ?? "sandbox-agency-portal",
    purpose: "Food benefits renewal in the sandbox agency portal",
    payload: { fullName: "Rosa Testcase", householdSize: opts.size ?? "3" },
    idempotencyKey: `replay-${crypto.randomUUID()}`,
    actor: "foreground",
    sources: [],
    origin: "person",
    generation: 0,
    ...(opts.documentId ? { documentId: opts.documentId } : {}),
    ...(opts.turnId ? { proposalTurn: opts.turnId } : {}),
  });
  const out = (await res.json()) as { status: string; approval: { id: string } };
  expect(out.status).toBe("needs_approval");
  return out.approval.id;
}

async function bind(h: string, approvalId: string, body: unknown = replayBody()) {
  return call(h, "PUT", `/approvals/${approvalId}/replay`, body);
}

// The page's address: Engine answers its path, and the caller joins it
// to the Engine address it uses.
const pageUrl = async (res: Response) => `https://engine.test${((await res.json()) as { path: string }).path}`;

async function bound(h: string, approvalId: string, body?: unknown): Promise<string> {
  const res = await bind(h, approvalId, body);
  expect(res.status).toBe(201);
  return pageUrl(res);
}

async function open(url: string): Promise<{ status: number; html: string; headers: Headers }> {
  const res = await SELF.fetch(url);
  return { status: res.status, html: await res.text(), headers: res.headers };
}

const images = (html: string) => html.match(/<img src="data:image\/png;base64,/g)?.length ?? 0;

describe("storing a fill's steps", () => {
  it("keeps each screenshot encrypted for the person, and a retry gets the same link", async () => {
    const h = handle("replay-store");
    const person = personIdForHandle(h);
    const approvalId = await propose(h);
    const url = await bound(h, approvalId);
    expect(url).toMatch(/^https:\/\/engine\.test\/fill\/[0-9a-f]{32}$/);

    const again = await bind(h, approvalId, replayBody([7, 8]));
    expect(again.status).toBe(200);
    expect(await pageUrl(again)).toBe(url);
    expect(await pageUrl(await call(h, "GET", `/approvals/${approvalId}/replay`))).toBe(url);

    const listed = await files().list({ prefix: `persons/${person}/docs/g0/fill-${approvalId}-` });
    expect(listed.objects).toHaveLength(3);
    for (const object of listed.objects) {
      const raw = await (await files().get(object.key))!.text();
      const [, id, step] = /\/(fill-[^/]+-(\d+))\.[0-9a-f]+$/.exec(object.key)!;
      const i = Number(step);
      expect(raw).not.toContain(b64(png(i + 1)));
      expect(await getDocumentBytes(files(), KEK, person, id!, object.key)).toEqual(png(i + 1));
      await expect(getDocumentBytes(files(), KEK, personIdForHandle(handle("someone-else")), id!, object.key)).rejects.toThrow();
    }
    // R2 keeps the link's hash, never the link.
    const token = url.split("/").pop()!;
    expect(await files().get(await linkKey(token))).not.toBeNull();
    const everything = await files().list();
    expect(everything.objects.some((o) => o.key.includes(token))).toBe(false);
  });

  it("refuses screens that are not PNGs, too many steps, a missing generation, and any service but the agent", async () => {
    const h = handle("replay-input");
    const approvalId = await propose(h);
    const notPng = { generation: 0, labels: LABELS, steps: [{ caption: "Mano opened the form.", pngB64: btoa("not a png") }] };
    expect((await bind(h, approvalId, notPng)).status).toBe(400);
    expect((await bind(h, approvalId, replayBody(Array.from({ length: 25 }, (_, i) => i)))).status).toBe(400);
    expect((await bind(h, approvalId, { labels: LABELS, steps: replayBody().steps })).status).toBe(400);
    const halfPixel = { generation: 0, labels: LABELS, steps: [{ caption: "Mano filled in a field.", pngB64: b64(png(1)), focus: { x: 10.5, y: 10 } }] };
    expect((await bind(h, approvalId, halfPixel)).status).toBe(400);
    const noHeader = { generation: 0, labels: LABELS, steps: [{ caption: "Mano opened the form.", pngB64: b64(png(1).subarray(0, 9)) }] };
    expect((await bind(h, approvalId, noHeader)).status).toBe(400);
    expect((await call(h, "PUT", `/approvals/${approvalId}/replay`, replayBody(), CHANNELS_TOKEN)).status).toBe(403);
  });
});

describe("binding a replay to its approval", () => {
  it("binds only to an approval that still waits, in the conversation it was prepared for", async () => {
    const h = handle("replay-bind");
    expect((await bind(h, "no-such-approval")).status).toBe(404);

    const declined = await propose(h);
    expect((await call(h, "POST", `/approvals/${declined}/reject`)).status).toBe(200);
    expect((await bind(h, declined)).status).toBe(409);

    const waiting = await propose(h);
    expect((await bind(h, waiting, replayBody([1], 3))).status).toBe(409);
    expect((await call(h, "GET", `/approvals/${waiting}/replay`)).status).toBe(404);
  });

  it("a page shows the steps and the values Engine froze, under the form's labels", async () => {
    const h = handle("replay-page");
    const approvalId = await propose(h, { documentId: await storeProof(h) });
    const page = await open(await bound(h, approvalId));

    expect(page.status).toBe(200);
    // Three steps, then the whole filled form: a typed step shows its
    // field up close, centered on where Mano clicked.
    expect(images(page.html)).toBe(4);
    expect(page.html.match(/<div class="zoom">/g)).toHaveLength(2);
    // Near the top edge the close-up stops at the edge instead of past it.
    expect(page.html).toContain('style="width:200%;left:-30.00%;top:0.00%"');
    expect(page.html).toContain('style="width:200%;left:-30.00%;top:-88.89%"');
    expect(page.html).toContain('<h2>The filled form</h2><img src="data:image/png;base64,');
    expect(page.html).toContain("This is exactly what Mano will send when you reply YES.");
    expect(page.html).toContain("<dt>Goes to</dt><dd>the State Benefits Renewal Office test portal</dd><");
    expect(page.html).not.toContain("sandbox-agency-portal");
    expect(page.html).toContain("<dt>Full legal name</dt><dd>Rosa Testcase</dd>");
    expect(page.html).toContain("Reply YES to Mano's text to send exactly this, or NO to stop.");
    expect(page.html).toContain("<dt>People in household</dt><dd>3</dd>");
    expect(page.html).toContain("With your document attached.");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("a recipient with no display name shows as unnamed, never as its ID", async () => {
    const h = handle("replay-unnamed");
    const approvalId = await propose(h, { recipient: "sandbox:county-portal" });
    const page = await open(await bound(h, approvalId));
    expect(page.status).toBe(200);
    expect(page.html).toContain("<dt>Goes to</dt><dd>an office Mano has no name for</dd><");
    expect(page.html).not.toContain("county-portal");
  });

  it("a focus off the screenshot shows the whole screenshot", async () => {
    const h = handle("replay-offscreen");
    const approvalId = await propose(h);
    const body = { generation: 0, labels: LABELS, steps: [{ caption: "Mano filled in a field.", pngB64: b64(png(1)), focus: { x: 1280, y: 10 } }] };
    const page = await open(await bound(h, approvalId, body));
    expect(page.html).not.toContain('class="zoom"');
    expect(images(page.html)).toBe(1);
  });

  it("captions and labels are text on the page, never markup", async () => {
    const h = handle("replay-escape");
    const approvalId = await propose(h);
    const body = { generation: 0, labels: { fullName: "<b>Name</b>" }, steps: [{ caption: '<script>alert("x")</script>', pngB64: b64(png(1)) }] };
    const page = await open(await bound(h, approvalId, body));
    expect(page.html).not.toContain("<script>");
    expect(page.html).toContain("&lt;script&gt;");
    expect(page.html).toContain("<dt>&lt;b&gt;Name&lt;/b&gt;</dt>");
  });

  it("after the person says yes, the page shows what they approved", async () => {
    const h = handle("replay-yes");
    const approvalId = await propose(h);
    const url = await bound(h, approvalId);
    expect(((await (await call(h, "POST", `/approvals/${approvalId}/approve`)).json()) as { status: string }).status).toBe("completed");
    const page = await open(url);
    expect(page.html).toContain("You said yes to this version.");
    expect(images(page.html)).toBe(4);
  });
});

describe("a link opened after the draft changed", () => {
  it("says so when a newer draft replaced it, and shows none of the old steps", async () => {
    const h = handle("replay-newer");
    await turn(h, "turn-replay-1");
    const first = await propose(h, { turnId: "turn-replay-1" });
    const oldUrl = await bound(h, first);
    expect(images((await open(oldUrl)).html)).toBe(4);

    await turn(h, "turn-replay-2");
    const second = await propose(h, { turnId: "turn-replay-2", size: "4" });
    const newUrl = await bound(h, second, replayBody([4, 5]));

    const old = await open(oldUrl);
    expect(old.status).toBe(200);
    expect(old.html).toContain("This form changed");
    expect(images(old.html)).toBe(0);
    expect(old.html).not.toContain("Rosa Testcase");
    const fresh = await open(newUrl);
    expect(images(fresh.html)).toBe(3);
    expect(fresh.html).toContain("<dt>People in household</dt><dd>4</dd>");
  });

  it("says so when the attached document changed after the approval froze it", async () => {
    const h = handle("replay-doc");
    const person = personIdForHandle(h);
    const proof = await storeProof(h);
    const approvalId = await propose(h, { documentId: proof });
    const url = await bound(h, approvalId);
    expect((await open(url)).html).toContain("This is exactly what Mano will send");

    const [stored] = (await files().list({ prefix: `persons/${person}/docs/g0/${proof}.` })).objects;
    await files().put(stored!.key, JSON.stringify(await encryptForPerson(new TextEncoder().encode("synthetic pay stub v2"), KEK, documentAad(person, proof))));

    const page = await open(url);
    expect(page.html).toContain("This form changed");
    expect(images(page.html)).toBe(0);
    // The gateway agrees: a YES now is refused as stale.
    expect(((await (await call(h, "POST", `/approvals/${approvalId}/approve`)).json()) as { status: string }).status).toBe("stale");
    expect((await open(url)).html).toContain("This form changed");
  });

  it("says the version is closed after the person said no", async () => {
    const h = handle("replay-no");
    const approvalId = await propose(h);
    const url = await bound(h, approvalId);
    await call(h, "POST", `/approvals/${approvalId}/reject`);
    const page = await open(url);
    expect(page.html).toContain("This form is closed");
    expect(images(page.html)).toBe(0);
  });
});

describe("the link a question carries", () => {
  const link = (h: string, approvalId: string) => call(h, "GET", `/approvals/${approvalId}/replay`);

  it("is answered only while its approval waits as the latest version", async () => {
    const h = handle("replay-question");
    await turn(h, "turn-question-1");
    const first = await propose(h, { turnId: "turn-question-1" });
    const firstUrl = await bound(h, first);
    expect(await pageUrl(await link(h, first))).toBe(firstUrl);

    // A newer draft replaces it; the first still reads pending until closed.
    await turn(h, "turn-question-2");
    const second = await propose(h, { turnId: "turn-question-2", size: "4" });
    expect((await link(h, first)).status).toBe(404);
    const secondUrl = await bound(h, second, replayBody([4, 5]));
    expect(await pageUrl(await link(h, second))).toBe(secondUrl);

    await call(h, "POST", `/approvals/${second}/reject`);
    expect((await link(h, second)).status).toBe(404);
  });

  it("is not answered after the person said yes", async () => {
    const h = handle("replay-question-yes");
    const approvalId = await propose(h);
    await bound(h, approvalId);
    expect(((await (await call(h, "POST", `/approvals/${approvalId}/approve`)).json()) as { status: string }).status).toBe("completed");
    expect((await link(h, approvalId)).status).toBe(404);
  });
});

describe("only the person's link opens the page", () => {
  it("refuses a made-up, altered or session token, and any other path", async () => {
    const h = handle("replay-access");
    const url = await bound(h, await propose(h));
    const token = url.split("/").pop()!;
    const altered = `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;
    const session = await mintSessionToken({ kind: "person", sub: personIdForHandle(h) }, SESSION_SECRET);

    for (const path of [`/fill/${"0".repeat(32)}`, `/fill/${altered}`, `/fill/${session}`, `/fill/${token.toUpperCase()}`, "/fill", `/fill/${token}/0`]) {
      const res = await open(`https://engine.test${path}`);
      expect(res.status, path).toBe(404);
      expect(images(res.html)).toBe(0);
    }
    expect((await SELF.fetch(url, { method: "POST" })).status).toBe(405);
  });

  it("another person's grant or session reaches neither the link nor the binding", async () => {
    const maria = handle("replay-owner");
    const other = handle("replay-other");
    const approvalId = await propose(maria);
    await bound(maria, approvalId);

    // The other person's own routes do not hold Maria's approval.
    expect((await call(other, "GET", `/approvals/${approvalId}/replay`)).status).toBe(404);
    expect((await bind(other, approvalId)).status).toBe(404);
    // Their grant on Maria's route is refused before anything runs.
    const crossed = await SELF.fetch(`https://engine.test/api/persons/${personIdForHandle(maria)}/approvals/${approvalId}/replay`, {
      headers: { authorization: `Bearer ${AGENT_TOKEN}`, "x-mano-handle-grant": await mintHandleGrant(other, GRANT_SECRET) },
    });
    expect(crossed.status).toBe(403);
    const otherSession = await mintSessionToken({ kind: "person", sub: personIdForHandle(other) }, SESSION_SECRET);
    const bySession = await SELF.fetch(`https://engine.test/api/persons/${personIdForHandle(maria)}/approvals/${approvalId}/replay`, {
      headers: { authorization: `Bearer ${otherSession}` },
    });
    expect(bySession.status).toBe(403);
  });

  it("an expired link opens nothing", async () => {
    const h = handle("replay-expired");
    const url = await bound(h, await propose(h));
    const key = await linkKey(url.split("/").pop()!);
    const entry = JSON.parse(await (await files().get(key))!.text()) as { expiresAtMs: number };
    await files().put(key, JSON.stringify({ ...entry, expiresAtMs: Date.now() - 1 }));
    const page = await open(url);
    expect(page.status).toBe(404);
    expect(page.html).toContain("This page is not available");
  });

  it("deleting the conversation deletes the replay, its images and its link", async () => {
    const h = handle("replay-delete");
    const person = personIdForHandle(h);
    const approvalId = await propose(h);
    const url = await bound(h, approvalId);
    const key = await linkKey(url.split("/").pop()!);

    expect((await call(h, "DELETE", "/conversation", { generation: 1 }, CHANNELS_TOKEN)).status).toBe(200);

    expect((await open(url)).status).toBe(404);
    expect(await files().get(key)).toBeNull();
    expect((await files().list({ prefix: `persons/${person}/docs/` })).objects).toHaveLength(0);
  });
});
