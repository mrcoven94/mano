import { describe, expect, it } from "vitest";
import { signPagesBody } from "../src/auth.js";
import { MemoryPageStore } from "../src/store.js";
import { handleCreate, resolvePage, type PagesDeps } from "../src/service.js";
import { PAGE_TTL_MS } from "../src/tokens.js";

const HMAC = "test pages hmac secret";

function kekB64(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const ESTIMATE = {
  program: "SNAP",
  programLine: "food benefits that cover groceries",
  rangeLow: 180,
  rangeHigh: 240,
  period: "a month",
  factsUsed: [{ label: "Pay each month", value: "$1,900" }],
  changes: ["a raise at work"],
  nextStep: "Send your pay stub.",
};

function setup(over: Partial<PagesDeps> = {}): { d: PagesDeps; advance(ms: number): void } {
  let now = 1_800_000_000_000;
  const d: PagesDeps = {
    store: new MemoryPageStore(),
    secrets: { hmacSecret: HMAC, kekB64: kekB64(), allowInsecure: false },
    baseUrl: "https://withmano.com",
    nowMs: () => now,
    log: () => {},
    ...over,
  };
  return { d, advance: (ms: number) => { now += ms; } };
}

function deps(over: Partial<PagesDeps> = {}): PagesDeps {
  return setup(over).d;
}

async function signedCreate(
  d: PagesDeps,
  body: unknown,
  atSeconds: number,
  idempotencyKey: string | null = null,
) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const header = await signPagesBody(d.secrets.hmacSecret || HMAC, atSeconds, raw);
  return handleCreate(raw, header, idempotencyKey, d);
}

describe("handleCreate", () => {
  it("creates a page and returns its url plus text to send", async () => {
    const d = deps();
    const out = await signedCreate(d, { kind: "estimate", data: ESTIMATE }, 1_800_000_000);
    expect(out.status).toBe(201);
    if (out.status !== 201) return;
    expect(out.url).toMatch(/^https:\/\/withmano\.com\/p\/[A-Za-z0-9_-]{22}$/);
    expect(out.text).toContain(out.url);
    expect(out.text).toContain("SNAP");
    expect(out.reused).toBe(false);
  });

  it("requires the HMAC", async () => {
    const d = deps();
    const raw = JSON.stringify({ kind: "estimate", data: ESTIMATE });
    expect((await handleCreate(raw, null, null, d)).status).toBe(401);
    const bad = await signPagesBody("wrong secret", 1_800_000_000, raw);
    expect((await handleCreate(raw, bad, null, d)).status).toBe(401);
  });

  it("rejects bad json and bad data with plain errors", async () => {
    const d = deps();
    const raw = "not json";
    const header = await signPagesBody(HMAC, 1_800_000_000, raw);
    expect((await handleCreate(raw, header, null, d)).status).toBe(400);
    const out = await signedCreate(d, { kind: "estimate", data: { ...ESTIMATE, rangeLow: 999 } }, 1_800_000_000);
    expect(out.status).toBe(400);
    if (out.status === 400) expect(out.errors?.length).toBeGreaterThan(0);
  });

  it("reuses the same page for a repeated idempotency key", async () => {
    const d = deps();
    const first = await signedCreate(d, { kind: "estimate", data: ESTIMATE }, 1_800_000_000, "agent-turn-1");
    const second = await signedCreate(d, { kind: "estimate", data: ESTIMATE }, 1_800_000_001, "agent-turn-1");
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    if (first.status === 201 && second.status === 201) {
      expect(second.url).toBe(first.url);
      expect(second.reused).toBe(true);
    }
  });

  it("fails closed with no HMAC secret and no KEK", async () => {
    const d = deps({ secrets: { hmacSecret: "", kekB64: kekB64(), allowInsecure: false } });
    const out = await signedCreate(d, { kind: "estimate", data: ESTIMATE }, 1_800_000_000);
    expect(out.status).toBe(503);
    const d2 = deps({ secrets: { hmacSecret: HMAC, kekB64: null, allowInsecure: false } });
    const out2 = await signedCreate(d2, { kind: "estimate", data: ESTIMATE }, 1_800_000_000);
    expect(out2.status).toBe(503);
  });

  it("stores plaintext locally only when allowed, and says so", async () => {
    const lines: string[] = [];
    const d = deps({
      secrets: { hmacSecret: HMAC, kekB64: null, allowInsecure: true },
      log: (line) => lines.push(line),
    });
    const out = await signedCreate(d, { kind: "estimate", data: ESTIMATE }, 1_800_000_000);
    expect(out.status).toBe(201);
    expect(lines.some((l) => l.includes("without encryption"))).toBe(true);
  });
});

describe("resolvePage", () => {
  it("opens a live page", async () => {
    const d = deps();
    const created = await signedCreate(d, { kind: "estimate", data: ESTIMATE }, 1_800_000_000);
    if (created.status !== 201) throw new Error("setup failed");
    const found = await resolvePage(created.token, d);
    expect(found.state).toBe("live");
    if (found.state === "live") {
      expect(found.page.page.kind).toBe("estimate");
      expect(found.page.expiresAtMs - found.page.createdAtMs).toBe(PAGE_TTL_MS);
    }
  });

  it("treats unknown, malformed and expired pages as gone", async () => {
    const { d, advance } = setup();
    const created = await signedCreate(d, { kind: "estimate", data: ESTIMATE }, 1_800_000_000);
    if (created.status !== 201) throw new Error("setup failed");
    expect((await resolvePage("AAAAAAAAAAAAAAAAAAAAAA", d)).state).toBe("gone");
    expect((await resolvePage("not a token", d)).state).toBe("gone");
    expect((await resolvePage(null, d)).state).toBe("gone");
    advance(PAGE_TTL_MS + 1000);
    expect((await resolvePage(created.token, d)).state).toBe("gone");
  });
});
