import { describe, expect, it } from "vitest";
import { signPagesBody } from "../src/auth.js";
import { recordOnlyForwarder } from "../src/gateway.js";
import {
  handleAction,
  handleAgentRevoke,
  handleCreate,
  resolvePage,
  type PagesDeps,
} from "../src/service.js";
import { MemoryPageStore } from "../src/store.js";

const HMAC = "test pages hmac secret";

function kekB64(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function deps(over: Partial<PagesDeps> = {}): PagesDeps {
  return {
    store: new MemoryPageStore(),
    secrets: { hmacSecret: HMAC, kekB64: kekB64(), allowInsecure: false },
    baseUrl: "https://withmano.com",
    nowMs: () => 1_800_000_000_000,
    log: () => {},
    ...over,
  };
}

async function create(d: PagesDeps, kind: string, data: unknown): Promise<string> {
  const raw = JSON.stringify({ kind, data });
  const header = await signPagesBody(HMAC, 1_800_000_000, raw);
  const out = await handleCreate(raw, header, null, d);
  if (out.status !== 201) throw new Error(`setup failed: ${out.status}`);
  return out.token;
}

const CHECKLIST = {
  title: "Papers for your renewal",
  items: [
    { id: "paystub", label: "Pay stub", checked: false },
    { id: "idcard", label: "Photo ID", checked: false },
  ],
};

const REVIEW = {
  formName: "SNAP renewal",
  fields: [
    { id: "name", label: "Full name", value: "Maria Santos", unsure: false },
    { id: "pay", label: "Monthly pay", value: "$1,900", unsure: true },
  ],
};

const APPROVE = {
  action: "file your SNAP renewal",
  forWhom: "Maria Santos",
  destination: "Springfield County SNAP office",
  sends: [{ label: "Renewal form" }],
};

describe("handleAction check", () => {
  it("saves checked items and keeps the rest", async () => {
    const d = deps();
    const token = await create(d, "checklist", CHECKLIST);
    const out = await handleAction(token, JSON.stringify({ op: "check", id: "paystub", checked: true }), d);
    expect(out.status).toBe(200);
    if (out.status !== 200 || "needCode" in out) return;
    if (out.page.page.kind !== "checklist") throw new Error("wrong kind");
    expect(out.page.page.items.find((i) => i.id === "paystub")?.checked).toBe(true);
    expect(out.page.page.items.find((i) => i.id === "idcard")?.checked).toBe(false);
    const reopened = await resolvePage(token, d);
    if (reopened.state !== "live" || reopened.page.page.kind !== "checklist") throw new Error("setup failed");
    expect(reopened.page.page.items.find((i) => i.id === "paystub")?.checked).toBe(true);
  });

  it("rejects unknown items and wrong kinds", async () => {
    const d = deps();
    const token = await create(d, "checklist", CHECKLIST);
    expect((await handleAction(token, JSON.stringify({ op: "check", id: "nope", checked: true }), d)).status).toBe(400);
    const estimate = await create(d, "estimate", {
      program: "SNAP",
      programLine: "food benefits",
      rangeLow: 1,
      rangeHigh: 2,
      period: "a month",
      factsUsed: [{ label: "a", value: "b" }],
      changes: [],
      nextStep: "Send a stub.",
    });
    expect((await handleAction(estimate, JSON.stringify({ op: "check", id: "paystub", checked: true }), d)).status).toBe(400);
  });
});

describe("handleAction edit", () => {
  it("saves edited review values", async () => {
    const d = deps();
    const token = await create(d, "review", REVIEW);
    const out = await handleAction(token, JSON.stringify({ op: "edit", values: { pay: "$2,050" } }), d);
    expect(out.status).toBe(200);
    if (out.status !== 200 || "needCode" in out || out.page.page.kind !== "review") return;
    expect(out.page.page.fields.find((f) => f.id === "pay")?.value).toBe("$2,050");
    expect(out.page.page.fields.find((f) => f.id === "name")?.value).toBe("Maria Santos");
  });

  it("rejects unknown fields and oversize values", async () => {
    const d = deps();
    const token = await create(d, "review", REVIEW);
    expect((await handleAction(token, JSON.stringify({ op: "edit", values: { nope: "x" } }), d)).status).toBe(400);
    expect((await handleAction(token, JSON.stringify({ op: "edit", values: { pay: "x".repeat(2001) } }), d)).status).toBe(400);
  });
});

describe("handleAction decide", () => {
  it("records the choice with a hash of the exact proposal", async () => {
    const lines: string[] = [];
    const d = deps({ log: (line) => lines.push(line) });
    const token = await create(d, "approve", APPROVE);
    const out = await handleAction(token, JSON.stringify({ op: "decide", choice: "approved" }), d);
    expect(out.status).toBe(200);
    if (out.status !== 200 || "needCode" in out || out.page.page.kind !== "approve") return;
    expect(out.page.page.decision?.choice).toBe("approved");
    expect(out.page.page.decision?.proposalHash).toMatch(/^[0-9a-f]{64}$/);
    expect(out.approval?.forwarded).toBe(false);
    expect(lines.join("\n")).not.toContain("Maria Santos");
  });

  it("refuses a second answer", async () => {
    const d = deps();
    const token = await create(d, "approve", APPROVE);
    await handleAction(token, JSON.stringify({ op: "decide", choice: "approved" }), d);
    const again = await handleAction(token, JSON.stringify({ op: "decide", choice: "declined" }), d);
    expect(again.status).toBe(400);
  });

  it("asks for the one time code when the page requires it", async () => {
    const d = deps();
    const token = await create(d, "approve", { ...APPROVE, otpRequired: true });
    const out = await handleAction(token, JSON.stringify({ op: "decide", choice: "approved" }), d);
    expect(out.status).toBe(501);
    const withOtp = deps({ verifyOtp: async (code) => code === "123456" });
    const token2 = await create(withOtp, "approve", { ...APPROVE, otpRequired: true });
    const missing = await handleAction(token2, JSON.stringify({ op: "decide", choice: "approved" }), withOtp);
    expect(missing.status).toBe(200);
    if (missing.status === 200 && "needCode" in missing) expect(missing.needCode).toBe(true);
    else throw new Error("expected a code request");
    const wrong = await handleAction(token2, JSON.stringify({ op: "decide", choice: "approved", code: "000000" }), withOtp);
    expect(wrong.status).toBe(400);
    const right = await handleAction(token2, JSON.stringify({ op: "decide", choice: "declined", code: "123456" }), withOtp);
    expect(right.status).toBe(200);
  });
});

describe("revoke", () => {
  it("lets the page owner revoke with the token", async () => {
    const d = deps();
    const token = await create(d, "checklist", CHECKLIST);
    expect((await handleAction(token, JSON.stringify({ op: "revoke" }), d)).status).toBe(200);
    expect((await resolvePage(token, d)).state).toBe("gone");
  });

  it("lets the agent revoke with the HMAC, and no one else", async () => {
    const d = deps();
    const token = await create(d, "checklist", CHECKLIST);
    const raw = JSON.stringify({ token });
    const good = await signPagesBody(HMAC, 1_800_000_000, raw);
    expect((await handleAgentRevoke(raw, "t=1,v1=deadbeef", d)).status).toBe(401);
    expect((await handleAgentRevoke(raw, good, d)).status).toBe(200);
    expect((await resolvePage(token, d)).state).toBe("gone");
  });
});

describe("handleAction on gone pages", () => {
  it("answers gone with the same plain words", async () => {
    const d = deps();
    const out = await handleAction("AAAAAAAAAAAAAAAAAAAAAA", JSON.stringify({ op: "revoke" }), d);
    expect(out.status).toBe(404);
    if (out.status === 404) expect(out.error).toBe("this page has expired");
  });
});

describe("recordOnlyForwarder", () => {
  it("records without acting outside Mano", async () => {
    const out = await recordOnlyForwarder.forwardApproval({
      pageId: "abc",
      proposalHash: "def",
      choice: "approved",
      atMs: 1,
    });
    expect(out.forwarded).toBe(false);
  });
});
