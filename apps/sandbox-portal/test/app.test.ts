import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG, handleRequest, type PortalConfig } from "../src/app";
import { TEST_BANNER } from "../src/pages";
import type { Household } from "../src/store";
import { MemoryStore } from "./memory-store";

const BASE = "https://portal.test";

const HOUSEHOLD: Household = {
  fullName: "Maria Santos",
  dateOfBirth: "1988-04-12",
  address: "42 Test Street, Fresno, CA 93701",
  phone: "555-010-2030",
  householdSize: "3",
  monthlyIncome: "2400",
};

function testConfig(overrides: Partial<PortalConfig> = {}): PortalConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function cookieFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie") ?? "";
  const pair = setCookie.split(";")[0] ?? "";
  if (!pair.includes("=")) throw new Error("response set no cookie");
  return pair;
}

function householdForm(overrides: Record<string, string> = {}): URLSearchParams {
  const params = new URLSearchParams();
  const fields: Record<string, string> = { ...HOUSEHOLD, ...overrides };
  for (const [k, v] of Object.entries(fields)) params.set(k, v);
  return params;
}

function pdfFile(name = "paystub.pdf", bytes = "fake-pdf-bytes"): File {
  return new File([bytes], name, { type: "application/pdf" });
}

function keyFromReview(htmlText: string): string {
  const match = /name="key" value="([^"]+)"/.exec(htmlText);
  if (!match?.[1]) throw new Error("review page has no submission key");
  return match[1];
}

function confirmationFrom(htmlText: string): string {
  const match = /class="conf">([^<]+)</.exec(htmlText);
  if (!match?.[1]) throw new Error("page has no confirmation number");
  return match[1];
}

async function postHousehold(store: MemoryStore, config: PortalConfig): Promise<string> {
  const res = await handleRequest(
    new Request(`${BASE}/apply/household`, { method: "POST", body: householdForm() }),
    store,
    config,
  );
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/apply/documents");
  return cookieFrom(res);
}

async function postDocuments(store: MemoryStore, config: PortalConfig, cookie: string): Promise<void> {
  const form = new FormData();
  form.append("document1", pdfFile());
  const res = await handleRequest(
    new Request(`${BASE}/apply/documents`, { method: "POST", headers: { cookie }, body: form }),
    store,
    config,
  );
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/apply/review");
}

describe("home page", () => {
  test("labels itself a test system and links the application", async () => {
    const store = new MemoryStore();
    const res = await handleRequest(new Request(`${BASE}/`), store, testConfig());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(TEST_BANNER);
    expect(text).toContain('href="/apply"');
  });
});

describe("renewal flow", () => {
  test("household to documents to review to confirmation", async () => {
    const store = new MemoryStore();
    const config = testConfig();
    const cookie = await postHousehold(store, config);
    await postDocuments(store, config, cookie);

    const review = await handleRequest(new Request(`${BASE}/apply/review`, { headers: { cookie } }), store, config);
    expect(review.status).toBe(200);
    const reviewText = await review.text();
    expect(reviewText).toContain("Maria Santos");
    expect(reviewText).toContain("paystub.pdf");
    const key = keyFromReview(reviewText);

    const submitForm = new URLSearchParams();
    submitForm.set("key", key);
    const submit = await handleRequest(
      new Request(`${BASE}/submissions`, { method: "POST", headers: { cookie }, body: submitForm }),
      store,
      config,
    );
    expect(submit.status).toBe(200);
    const confirmation = confirmationFrom(await submit.text());
    expect(confirmation).toMatch(/^SR-[A-Z2-9]{8}$/);

    const status = await handleRequest(new Request(`${BASE}/submissions/${key}`), store, config);
    expect(status.status).toBe(200);
    const statusJson = (await status.json()) as Record<string, string>;
    expect(statusJson["status"]).toBe("received");
    expect(statusJson["confirmationNumber"]).toBe(confirmation);
  });

  test("review without household redirects back to step 1", async () => {
    const store = new MemoryStore();
    const config = testConfig();
    const start = await handleRequest(new Request(`${BASE}/apply`), store, config);
    expect(start.status).toBe(200);
    const review = await handleRequest(new Request(`${BASE}/apply/review`), store, config);
    expect(review.status).toBe(403);
    expect(await review.text()).toContain("timed out");
  });
});

describe("idempotency", () => {
  test("resubmitting a key returns the original confirmation, no duplicate", async () => {
    const store = new MemoryStore();
    const config = testConfig();
    const cookie = await postHousehold(store, config);
    await postDocuments(store, config, cookie);
    const review = await handleRequest(new Request(`${BASE}/apply/review`, { headers: { cookie } }), store, config);
    const key = keyFromReview(await review.text());

    const submitForm = new URLSearchParams();
    submitForm.set("key", key);
    const first = await handleRequest(
      new Request(`${BASE}/submissions`, { method: "POST", headers: { cookie }, body: submitForm }),
      store,
      config,
    );
    const firstText = await first.text();
    expect(firstText).not.toContain("Already received");

    const second = await handleRequest(
      new Request(`${BASE}/submissions`, { method: "POST", headers: { cookie }, body: submitForm }),
      store,
      config,
    );
    const secondText = await second.text();
    expect(secondText).toContain("Already received");
    expect(confirmationFrom(secondText)).toBe(confirmationFrom(firstText));
    expect((await store.listSubmissions(10)).length).toBe(1);
  });

  test("unknown key reports not found", async () => {
    const store = new MemoryStore();
    const res = await handleRequest(new Request(`${BASE}/submissions/does-not-exist`), store, testConfig());
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, string>;
    expect(body["status"]).toBe("not_found");
  });

  test("the same key reconciles across the web form and the JSON API", async () => {
    const store = new MemoryStore();
    const config = testConfig();
    const cookie = await postHousehold(store, config);
    await postDocuments(store, config, cookie);
    const review = await handleRequest(new Request(`${BASE}/apply/review`, { headers: { cookie } }), store, config);
    const key = keyFromReview(await review.text());
    const submitForm = new URLSearchParams();
    submitForm.set("key", key);
    await handleRequest(
      new Request(`${BASE}/submissions`, { method: "POST", headers: { cookie }, body: submitForm }),
      store,
      config,
    );
    const retry = await handleRequest(
      new Request(`${BASE}/submissions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key }),
      }),
      store,
      config,
    );
    expect(retry.status).toBe(200);
    const body = (await retry.json()) as Record<string, unknown>;
    expect(body["duplicate"]).toBe(true);
    expect((await store.listSubmissions(10)).length).toBe(1);
  });

  test("a submission without a key is rejected", async () => {
    const store = new MemoryStore();
    const res = await handleRequest(
      new Request(`${BASE}/submissions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ household: HOUSEHOLD }),
      }),
      store,
      testConfig(),
    );
    expect(res.status).toBe(400);
  });
});

describe("slow mode", () => {
  test("stores the submission before holding the response", async () => {
    const store = new MemoryStore();
    const config = testConfig();
    const key = "slow-demo-key";
    let responded = false;
    const pending = handleRequest(
      new Request(`${BASE}/submissions?slowMs=1000`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key,
          household: HOUSEHOLD,
          files: [{ name: "paystub.pdf", type: "application/pdf", data: Buffer.from("bytes").toString("base64") }],
        }),
      }),
      store,
      config,
    ).finally(() => {
      responded = true;
    });
    // Poll like a caller would after its own timeout: the receipt must appear
    // while the submit response is still held.
    let seen: Response | null = null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const probe = await handleRequest(new Request(`${BASE}/submissions/${key}`), store, config);
      if (probe.status === 200) {
        seen = probe;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(seen?.status).toBe(200);
    expect(((await seen!.json()) as Record<string, string>)["status"]).toBe("received");
    expect(responded).toBe(false);
    const done = await pending;
    expect(done.status).toBe(200);
    const body = (await done.json()) as Record<string, string>;
    expect(body["confirmationNumber"]).toMatch(/^SR-/);
  });
});

describe("session timeout", () => {
  test("an expired session sees the timeout page and submits nothing", async () => {
    const store = new MemoryStore();
    const config = testConfig();
    const cookie = await postHousehold(store, config);
    const sessionId = cookie.split("=")[1] ?? "";
    const session = await store.getSession(sessionId);
    if (!session) throw new Error("session was not created");
    await store.putSession({ ...session, expiresAt: Date.now() - 1000 });

    const page = await handleRequest(new Request(`${BASE}/apply/documents`, { headers: { cookie } }), store, config);
    expect(page.status).toBe(403);
    expect(await page.text()).toContain("timed out");

    const submitForm = new URLSearchParams();
    submitForm.set("key", session.key);
    const submit = await handleRequest(
      new Request(`${BASE}/submissions`, { method: "POST", headers: { cookie }, body: submitForm }),
      store,
      config,
    );
    expect(submit.status).toBe(403);
    expect((await store.listSubmissions(10)).length).toBe(0);
  });
});

describe("validation", () => {
  test("household requires every field", async () => {
    const store = new MemoryStore();
    const config = testConfig();
    const res = await handleRequest(
      new Request(`${BASE}/apply/household`, { method: "POST", body: householdForm({ fullName: "" }) }),
      store,
      config,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("full legal name");
  });

  test("household size must be a whole number in range", async () => {
    const store = new MemoryStore();
    const config = testConfig();
    const res = await handleRequest(
      new Request(`${BASE}/apply/household`, { method: "POST", body: householdForm({ householdSize: "0" }) }),
      store,
      config,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Household size");
  });

  test("documents require at least one file", async () => {
    const store = new MemoryStore();
    const config = testConfig();
    const cookie = await postHousehold(store, config);
    const res = await handleRequest(
      new Request(`${BASE}/apply/documents`, { method: "POST", headers: { cookie }, body: new FormData() }),
      store,
      config,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("at least one document");
  });

  test("documents reject other file types", async () => {
    const store = new MemoryStore();
    const config = testConfig();
    const cookie = await postHousehold(store, config);
    const form = new FormData();
    form.append("document1", new File(["x"], "note.txt", { type: "text/plain" }));
    const res = await handleRequest(
      new Request(`${BASE}/apply/documents`, { method: "POST", headers: { cookie }, body: form }),
      store,
      config,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("PDF, PNG or JPG");
  });

  test("documents enforce the size cap", async () => {
    const store = new MemoryStore();
    const config = testConfig({ maxUploadBytes: 10 });
    const cookie = await postHousehold(store, config);
    const form = new FormData();
    form.append("document1", pdfFile());
    const res = await handleRequest(
      new Request(`${BASE}/apply/documents`, { method: "POST", headers: { cookie }, body: form }),
      store,
      config,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("larger than");
  });
});

describe("caseworker view", () => {
  test("lists submissions with detail and file download", async () => {
    const store = new MemoryStore();
    const config = testConfig();
    const empty = await handleRequest(new Request(`${BASE}/caseworker`), store, config);
    expect(await empty.text()).toContain("No applications received yet");

    const cookie = await postHousehold(store, config);
    await postDocuments(store, config, cookie);
    const review = await handleRequest(new Request(`${BASE}/apply/review`, { headers: { cookie } }), store, config);
    const submitForm = new URLSearchParams();
    submitForm.set("key", keyFromReview(await review.text()));
    const submit = await handleRequest(
      new Request(`${BASE}/submissions`, { method: "POST", headers: { cookie }, body: submitForm }),
      store,
      config,
    );
    const confirmation = confirmationFrom(await submit.text());

    const list = await handleRequest(new Request(`${BASE}/caseworker`), store, config);
    const listText = await list.text();
    expect(listText).toContain(confirmation);
    expect(listText).toContain("Maria Santos");

    const detail = await handleRequest(new Request(`${BASE}/caseworker/${confirmation}`), store, config);
    expect(detail.status).toBe(200);
    expect(await detail.text()).toContain("42 Test Street");

    const file = await handleRequest(new Request(`${BASE}/caseworker/${confirmation}/file/0`), store, config);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("application/pdf");
    expect(await file.text()).toBe("fake-pdf-bytes");

    const missing = await handleRequest(new Request(`${BASE}/caseworker/SR-00000000`), store, config);
    expect(missing.status).toBe(404);
  });
});

describe("test system labels", () => {
  test("every page says it is a test system", async () => {
    const store = new MemoryStore();
    const config = testConfig();
    const cookie = await postHousehold(store, config);
    const pages: Request[] = [new Request(`${BASE}/`), new Request(`${BASE}/apply`), new Request(`${BASE}/nope`)];
    for (const req of pages) {
      expect(await (await handleRequest(req, store, config)).text()).toContain(TEST_BANNER);
    }
    const authed = [`${BASE}/apply/documents`];
    for (const url of authed) {
      const res = await handleRequest(new Request(url, { headers: { cookie } }), store, config);
      expect(await res.text()).toContain(TEST_BANNER);
    }
    await postDocuments(store, config, cookie);
    const review = await handleRequest(new Request(`${BASE}/apply/review`, { headers: { cookie } }), store, config);
    const reviewText = await review.text();
    expect(reviewText).toContain(TEST_BANNER);
    const submitForm = new URLSearchParams();
    submitForm.set("key", keyFromReview(reviewText));
    const submit = await handleRequest(
      new Request(`${BASE}/submissions`, { method: "POST", headers: { cookie }, body: submitForm }),
      store,
      config,
    );
    const submitText = await submit.text();
    const confirmation = confirmationFrom(submitText);
    expect(submitText).toContain(TEST_BANNER);
    const list = await handleRequest(new Request(`${BASE}/caseworker`), store, config);
    expect(await list.text()).toContain(TEST_BANNER);
    const detail = await handleRequest(new Request(`${BASE}/caseworker/${confirmation}`), store, config);
    expect(await detail.text()).toContain(TEST_BANNER);
    const timeout = await handleRequest(new Request(`${BASE}/apply/review`), store, config);
    expect(await timeout.text()).toContain(TEST_BANNER);
  });

  test("redirects carry the test banner for clients that do not follow them", async () => {
    const store = new MemoryStore();
    const config = testConfig();
    const res = await handleRequest(
      new Request(`${BASE}/apply/household`, { method: "POST", body: householdForm() }),
      store,
      config,
    );
    expect(res.status).toBe(303);
    expect(await res.text()).toContain(TEST_BANNER);
  });
});
