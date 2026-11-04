import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG, handleRequest, type PortalConfig } from "../src/app";
import { FIXED_LAYOUTS, layoutFromSeed, mountFromPath, type HouseholdField } from "../src/layouts";
import { DECLARATION, type Household } from "../src/store";
import { TEST_BANNER } from "../src/pages";
import { MemoryFileStore, MemoryStore } from "./memory-store";

const BASE = "https://portal.test";
const TOKEN = "portal-test-token";
const DRAFT_TOKEN = "draft-test-token";
const DRAFT = "a".repeat(64);

const HOUSEHOLD: Household = {
  caseNumber: "LM-0042117",
  fullName: "Rosa Testcase",
  dateOfBirth: "1988-04-12",
  address: "100 Sample St, Larkmoor",
  phone: "253-555-0142",
  householdSize: "3",
  monthlyIncome: "2329",
};
const FIELDS = Object.keys(HOUSEHOLD).sort() as HouseholdField[];
const ADDRESSES = [...FIXED_LAYOUTS.map((l) => `/v/${l.id}`), "/scramble/judge-pick-7"];

function config(): PortalConfig {
  return { ...DEFAULT_CONFIG, portalToken: TOKEN, draftToken: DRAFT_TOKEN };
}

function portal() {
  const store = new MemoryStore();
  const files = new MemoryFileStore();
  const cfg = config();
  return (path: string, init?: RequestInit) => handleRequest(new Request(`${BASE}${path}`, init), store, files, cfg);
}

function form(draft = DRAFT) {
  return { method: "POST", body: new URLSearchParams({ ...HOUSEHOLD, draft }) };
}

describe("every layout holds the same fields", () => {
  const seeds = Array.from({ length: 300 }, (_, i) => `seed-${i}`);

  test("each field appears once, with a label of its own", () => {
    for (const layout of [...FIXED_LAYOUTS.map((l) => mountFromPath(`/v/${l.id}/apply`)!.layout), ...seeds.map(layoutFromSeed)]) {
      expect(layout.sections.flatMap((s) => s.fields).sort()).toEqual(FIELDS);
      expect(layout.sections.every((s) => s.fields.length > 0)).toBe(true);
      expect(new Set(FIELDS.map((f) => layout.labels[f])).size).toBe(FIELDS.length);
    }
  });

  test("a seed always gives the same layout, and seeds give different ones", () => {
    expect(layoutFromSeed("judge-pick-7")).toEqual(layoutFromSeed("judge-pick-7"));
    const distinct = new Set(seeds.map((seed) => JSON.stringify({ ...layoutFromSeed(seed), id: "" })));
    expect(distinct.size).toBe(seeds.length);
    expect(new Set(seeds.map((seed) => layoutFromSeed(seed).flow))).toEqual(new Set(["long", "wizard", "accordion"]));
  });
});

describe.each(ADDRESSES)("the renewal at %s", (prefix) => {
  test("is marked as a test system and posts every field to its own address", async () => {
    const page = await (await portal()(`${prefix}/apply?draft=${DRAFT}`)).text();
    expect(page).toContain(TEST_BANNER);
    expect(page).toContain("invented agency");
    expect(page).toContain(`action="${prefix}/apply/household"`);
    for (const field of FIELDS) expect(page).toContain(`name="${field}"`);
    expect(page).toContain(`name="draft" value="${DRAFT}"`);
  });

  test("saves the same draft, stays in the layout, and the browser still files nothing", async () => {
    const send = portal();
    const saved = await send(`${prefix}/apply/household`, form());
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe(`${prefix}/apply/documents`);
    const cookie = (saved.headers.get("set-cookie") ?? "").split(";")[0]!;

    for (const drafts of [`/drafts/${DRAFT}`, `${prefix}/drafts/${DRAFT}`]) {
      const read = await send(drafts, { headers: { authorization: `Bearer ${DRAFT_TOKEN}` } });
      expect(((await read.json()) as { household: Household }).household).toEqual(HOUSEHOLD);
    }

    const documents = await send(`${prefix}/apply/documents`, { headers: { cookie } });
    const upload = new FormData();
    upload.set("document1", new File(["%PDF-fake-bytes"], "paystub.pdf", { type: "application/pdf" }));
    expect(await documents.text()).toContain(`action="${prefix}/apply/documents"`);
    const attached = await send(`${prefix}/apply/documents`, { method: "POST", headers: { cookie }, body: upload });
    expect(attached.headers.get("location")).toBe(`${prefix}/apply/review`);
    const review = await (await send(`${prefix}/apply/review`, { headers: { cookie } })).text();
    expect(review).toContain(HOUSEHOLD.fullName);
    expect(review).toContain(TEST_BANNER);
    const submitted = await send(`${prefix}/apply/submit`, { method: "POST", headers: { cookie } });
    expect(await submitted.text()).toContain("Nothing has been filed yet");

    const caseworker = await (await send("/caseworker", { headers: { authorization: `Bearer ${TOKEN}` } })).text();
    expect(caseworker).toContain("No applications received yet.");
  });

  test("runs the same checks on the fields and keeps what was typed", async () => {
    const res = await portal()(`${prefix}/apply/household`, { method: "POST", body: new URLSearchParams({ ...HOUSEHOLD, householdSize: "many", draft: DRAFT }) });
    expect(res.status).toBe(400);
    const page = await res.text();
    expect(page).toContain("Household size must be a whole number");
    expect(page).toContain(`value="${HOUSEHOLD.fullName}"`);
  });

  test("a draft read still needs its token", async () => {
    expect((await portal()(`${prefix}/drafts/${DRAFT}`)).status).toBe(401);
  });

  test("files nothing and shows no staff page under the layout", async () => {
    const send = portal();
    const auth = { authorization: `Bearer ${TOKEN}` };
    const body = JSON.stringify({ household: HOUSEHOLD, declaration: { statement: DECLARATION, madeBy: "applicant" } });
    expect((await send(`${prefix}/submissions`, { method: "POST", headers: auth, body })).status).toBe(404);
    for (const path of ["/caseworker", "/staff", "/submissions/some-key"]) expect((await send(`${prefix}${path}`, { headers: auth })).status).toBe(404);
  });
});

describe("finding a layout", () => {
  test("an unknown layout or a bad seed is not a page", async () => {
    const send = portal();
    expect((await send("/v/not-a-layout/apply")).status).toBe(404);
    expect((await send("/scramble/bad_seed!/apply")).status).toBe(404);
    expect((await send(`/scramble/${"x".repeat(33)}/apply`)).status).toBe(404);
  });

  test("a bare address goes to its form", async () => {
    const res = await portal()("/v/larkmoor");
    expect(res.headers.get("location")).toBe("/v/larkmoor/apply");
  });

  test("the index lists the fixed layouts, and a seed or a blank box opens a generated one", async () => {
    const send = portal();
    const index = await (await send("/layouts")).text();
    expect(index).toContain(TEST_BANNER);
    for (const l of FIXED_LAYOUTS) expect(index).toContain(`/v/${l.id}/apply`);
    expect((await send("/scramble?seed=judge-1")).headers.get("location")).toBe("/scramble/judge-1/apply");
    expect((await send("/scramble?seed=")).headers.get("location")).toMatch(/^\/scramble\/[A-Za-z0-9-]{1,32}\/apply$/);
    expect((await send("/scramble?seed=no%20spaces")).status).toBe(400);
  });
});
