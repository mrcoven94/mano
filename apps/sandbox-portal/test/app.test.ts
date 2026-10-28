import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG, handleRequest, type PortalConfig } from "../src/app";
import { TEST_BANNER } from "../src/pages";
import type { Household } from "../src/store";
import { MemoryFileStore, MemoryStore } from "./memory-store";

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

function digestFromReview(htmlText: string): string {
  const match = /name="digest" value="([^"]+)"/.exec(htmlText);
  if (!match?.[1]) throw new Error("review page has no packet digest");
  return match[1];
}

/** Submit exactly what the review page shows, like the browser does. */
async function submitReview(store: MemoryStore, files: MemoryFileStore, config: PortalConfig, cookie: string): Promise<Response> {
  const review = await handleRequest(new Request(`${BASE}/apply/review`, { headers: { cookie } }), store, files, config);
  const reviewText = await review.text();
  const form = new URLSearchParams();
  form.set("key", keyFromReview(reviewText));
  form.set("digest", digestFromReview(reviewText));
  return handleRequest(
    new Request(`${BASE}/submissions`, { method: "POST", headers: { cookie }, body: form }),
    store,
    files,
    config,
  );
}

function confirmationFrom(htmlText: string): string {
  const match = /class="conf">([^<]+)</.exec(htmlText);
  if (!match?.[1]) throw new Error("page has no confirmation number");
  return match[1];
}

async function postHousehold(store: MemoryStore, files: MemoryFileStore, config: PortalConfig): Promise<string> {
  const res = await handleRequest(
    new Request(`${BASE}/apply/household`, { method: "POST", body: householdForm() }),
    store,
    files,
    config,
  );
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/apply/documents");
  return cookieFrom(res);
}

async function postDocuments(
  store: MemoryStore,
  files: MemoryFileStore,
  config: PortalConfig,
  cookie: string,
  uploads: File[] = [pdfFile()],
): Promise<void> {
  const form = new FormData();
  uploads.forEach((upload, i) => form.append(`document${i + 1}`, upload));
  const res = await handleRequest(
    new Request(`${BASE}/apply/documents`, { method: "POST", headers: { cookie }, body: form }),
    store,
    files,
    config,
  );
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/apply/review");
}

describe("home page", () => {
  test("labels itself a test system and links the application", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const res = await handleRequest(new Request(`${BASE}/`), store, new MemoryFileStore(), testConfig());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(TEST_BANNER);
    expect(text).toContain('href="/apply"');
  });
});

describe("renewal flow", () => {
  test("household to documents to review to confirmation", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const cookie = await postHousehold(store, files, config);
    await postDocuments(store, files, config, cookie);

    const review = await handleRequest(new Request(`${BASE}/apply/review`, { headers: { cookie } }), store, files, config);
    expect(review.status).toBe(200);
    const reviewText = await review.text();
    expect(reviewText).toContain("Maria Santos");
    expect(reviewText).toContain("paystub.pdf");
    const key = keyFromReview(reviewText);
    const digest = digestFromReview(reviewText);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);

    const submitForm = new URLSearchParams();
    submitForm.set("key", key);
    submitForm.set("digest", digest);
    const submit = await handleRequest(
      new Request(`${BASE}/submissions`, { method: "POST", headers: { cookie }, body: submitForm }),
      store,
      files,
      config,
    );
    expect(submit.status).toBe(200);
    const confirmation = confirmationFrom(await submit.text());
    expect(confirmation).toMatch(/^SR-[A-Z2-9]{8}$/);

    const status = await handleRequest(new Request(`${BASE}/submissions/${key}`), store, files, config);
    expect(status.status).toBe(200);
    const statusJson = (await status.json()) as Record<string, string>;
    expect(statusJson["status"]).toBe("received");
    expect(statusJson["confirmationNumber"]).toBe(confirmation);
    expect(statusJson["digest"]).toBe(digest);
  });

  test("editing after review rejects the stale submit", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const cookie = await postHousehold(store, files, config);
    await postDocuments(store, files, config, cookie);
    const review = await handleRequest(new Request(`${BASE}/apply/review`, { headers: { cookie } }), store, files, config);
    const stale = await review.text();
    const staleForm = new URLSearchParams();
    staleForm.set("key", keyFromReview(stale));
    staleForm.set("digest", digestFromReview(stale));

    // The household changes after the review page was shown.
    const edit = await handleRequest(
      new Request(`${BASE}/apply/household`, { method: "POST", headers: { cookie }, body: householdForm({ monthlyIncome: "9999" }) }),
      store,
      files,
      config,
    );
    expect(edit.status).toBe(303);

    const rejected = await handleRequest(
      new Request(`${BASE}/submissions`, { method: "POST", headers: { cookie }, body: staleForm }),
      store,
      files,
      config,
    );
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain("Changed since review");
    expect((await store.listSubmissions(10)).length).toBe(0);

    // A fresh review of the current draft submits fine.
    const fresh = await submitReview(store, files, config, cookie);
    expect(fresh.status).toBe(200);
    expect((await store.listSubmissions(10)).length).toBe(1);
  });

  test("a submit without the review digest is rejected", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const cookie = await postHousehold(store, files, config);
    await postDocuments(store, files, config, cookie);
    const review = await handleRequest(new Request(`${BASE}/apply/review`, { headers: { cookie } }), store, files, config);
    const form = new URLSearchParams();
    form.set("key", keyFromReview(await review.text()));
    const res = await handleRequest(
      new Request(`${BASE}/submissions`, { method: "POST", headers: { cookie }, body: form }),
      store,
      files,
      config,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Changed since review");
  });

  test("review without household redirects back to step 1", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const start = await handleRequest(new Request(`${BASE}/apply`), store, files, config);
    expect(start.status).toBe(200);
    const review = await handleRequest(new Request(`${BASE}/apply/review`), store, files, config);
    expect(review.status).toBe(403);
    expect(await review.text()).toContain("timed out");
  });
});

describe("idempotency", () => {
  test("resubmitting a key returns the original confirmation, no duplicate", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const packet = {
      key: "resubmit-key",
      household: HOUSEHOLD,
      files: [{ name: "paystub.pdf", type: "application/pdf", data: Buffer.from("bytes").toString("base64") }],
    };
    const post = () =>
      handleRequest(
        new Request(`${BASE}/submissions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(packet),
        }),
        store,
        files,
        config,
      );
    const first = (await (await post()).json()) as Record<string, unknown>;
    expect(first["duplicate"]).toBe(false);
    const second = (await (await post()).json()) as Record<string, unknown>;
    expect(second["duplicate"]).toBe(true);
    expect(second["confirmationNumber"]).toBe(first["confirmationNumber"]);
    expect((await store.listSubmissions(10)).length).toBe(1);
  });

  test("concurrent submits under one key file a single receipt", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const packet = {
      key: "race-key",
      household: HOUSEHOLD,
      files: [{ name: "paystub.pdf", type: "application/pdf", data: Buffer.from("bytes").toString("base64") }],
    };
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        handleRequest(
          new Request(`${BASE}/submissions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(packet),
          }),
          store,
          files,
          config,
        ),
      ),
    );
    expect(responses.every((r) => r.status === 200)).toBe(true);
    const bodies = (await Promise.all(responses.map((r) => r.json()))) as Array<Record<string, unknown>>;
    expect(new Set(bodies.map((b) => b["confirmationNumber"])).size).toBe(1);
    expect(bodies.filter((b) => b["duplicate"] === false)).toHaveLength(1);
    expect((await store.listSubmissions(10)).length).toBe(1);
  });

  test("unknown key reports not found", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const res = await handleRequest(new Request(`${BASE}/submissions/does-not-exist`), store, new MemoryFileStore(), testConfig());
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, string>;
    expect(body["status"]).toBe("not_found");
  });

  test("the same key reconciles across the web form and the JSON API", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const cookie = await postHousehold(store, files, config);
    await postDocuments(store, files, config, cookie);
    const review = await handleRequest(new Request(`${BASE}/apply/review`, { headers: { cookie } }), store, files, config);
    const reviewText = await review.text();
    const key = keyFromReview(reviewText);
    const submitForm = new URLSearchParams();
    submitForm.set("key", key);
    submitForm.set("digest", digestFromReview(reviewText));
    await handleRequest(
      new Request(`${BASE}/submissions`, { method: "POST", headers: { cookie }, body: submitForm }),
      store,
      files,
      config,
    );
    const retry = await handleRequest(
      new Request(`${BASE}/submissions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key,
          household: HOUSEHOLD,
          files: [{ name: "paystub.pdf", type: "application/pdf", data: Buffer.from("fake-pdf-bytes").toString("base64") }],
        }),
      }),
      store,
      files,
      config,
    );
    expect(retry.status).toBe(200);
    const body = (await retry.json()) as Record<string, unknown>;
    expect(body["duplicate"]).toBe(true);
    expect((await store.listSubmissions(10)).length).toBe(1);
  });

  test("a different packet under an existing key returns 409 with the received digest", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const file = { name: "paystub.pdf", type: "application/pdf", data: Buffer.from("bytes").toString("base64") };
    const post = (household: typeof HOUSEHOLD) =>
      handleRequest(
        new Request(`${BASE}/submissions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: "conflict-key", household, files: [file] }),
        }),
        store,
        files,
        config,
      );
    const first = (await (await post(HOUSEHOLD)).json()) as Record<string, unknown>;
    const retry = await post({ ...HOUSEHOLD, monthlyIncome: "9999" });
    expect(retry.status).toBe(409);
    const body = (await retry.json()) as { received: { confirmationNumber: string; digest: string } };
    expect(body.received.confirmationNumber).toBe(first["confirmationNumber"]);
    expect(body.received.digest).toBe(first["digest"]);
    expect((await store.listSubmissions(10)).length).toBe(1);
  });

  test("the receipt carries the digest the gateway can prove", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const submit = await handleRequest(
      new Request(`${BASE}/submissions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key: "digest-key",
          household: HOUSEHOLD,
          files: [{ name: "paystub.pdf", type: "application/pdf", data: Buffer.from("bytes").toString("base64") }],
        }),
      }),
      store,
      files,
      config,
    );
    const submitted = (await submit.json()) as Record<string, string>;
    expect(submitted["digest"]).toMatch(/^[0-9a-f]{64}$/);
    const receipt = (await (await handleRequest(new Request(`${BASE}/submissions/digest-key`), store, files, config)).json()) as Record<
      string,
      string
    >;
    expect(receipt["digest"]).toBe(submitted["digest"]);
    expect(receipt["confirmationNumber"]).toBe(submitted["confirmationNumber"]);
  });

  test("a web key from another session is rejected", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const cookieA = await postHousehold(store, files, config);
    await postDocuments(store, files, config, cookieA);
    const reviewA = await handleRequest(new Request(`${BASE}/apply/review`, { headers: { cookie: cookieA } }), store, files, config);
    const keyA = keyFromReview(await reviewA.text());
    const cookieB = await postHousehold(store, files, config);
    await postDocuments(store, files, config, cookieB);
    const form = new URLSearchParams();
    form.set("key", keyA);
    const res = await handleRequest(
      new Request(`${BASE}/submissions`, { method: "POST", headers: { cookie: cookieB }, body: form }),
      store,
      files,
      config,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("different session");
    expect((await store.listSubmissions(10)).length).toBe(0);
  });

  test("two API tokens file the same key independently", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const file = { name: "paystub.pdf", type: "application/pdf", data: Buffer.from("bytes").toString("base64") };
    const post = (token: string, household: typeof HOUSEHOLD) =>
      handleRequest(
        new Request(`${BASE}/submissions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ key: "shared-key", household, files: [file] }),
        }),
        store,
        files,
        config,
      );
    const a = (await (await post("token-one", HOUSEHOLD)).json()) as Record<string, unknown>;
    const b = (await (await post("token-two", { ...HOUSEHOLD, fullName: "Alex Rivera" })).json()) as Record<string, unknown>;
    expect(a["duplicate"]).toBe(false);
    expect(b["duplicate"]).toBe(false);
    expect(a["confirmationNumber"]).not.toBe(b["confirmationNumber"]);
    expect((await store.listSubmissions(10)).length).toBe(2);
  });

  test("an API retry of a browser filing duplicates instead of filing again", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const cookie = await postHousehold(store, files, config);
    await postDocuments(store, files, config, cookie);
    const review = await handleRequest(new Request(`${BASE}/apply/review`, { headers: { cookie } }), store, files, config);
    const reviewText = await review.text();
    const key = keyFromReview(reviewText);
    const form = new URLSearchParams();
    form.set("key", key);
    form.set("digest", digestFromReview(reviewText));
    const web = await handleRequest(
      new Request(`${BASE}/submissions`, { method: "POST", headers: { cookie }, body: form }),
      store,
      files,
      config,
    );
    const webConfirmation = confirmationFrom(await web.text());
    const retry = await handleRequest(
      new Request(`${BASE}/submissions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer gateway-token" },
        body: JSON.stringify({
          key,
          household: HOUSEHOLD,
          files: [{ name: "paystub.pdf", type: "application/pdf", data: Buffer.from("fake-pdf-bytes").toString("base64") }],
        }),
      }),
      store,
      files,
      config,
    );
    expect(retry.status).toBe(200);
    const body = (await retry.json()) as Record<string, unknown>;
    expect(body["duplicate"]).toBe(true);
    expect(body["confirmationNumber"]).toBe(webConfirmation);
    expect(body["scope"]).toBe("web");
    expect((await store.listSubmissions(10)).length).toBe(1);
  });

  test("reconcile reads the caller's scope first, then the web scope", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const file = { name: "paystub.pdf", type: "application/pdf", data: Buffer.from("bytes").toString("base64") };
    await handleRequest(
      new Request(`${BASE}/submissions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer token-one" },
        body: JSON.stringify({ key: "scoped-key", household: HOUSEHOLD, files: [file] }),
      }),
      store,
      files,
      config,
    );
    const own = (await (
      await handleRequest(new Request(`${BASE}/submissions/scoped-key`, { headers: { authorization: "Bearer token-one" } }), store, files, config)
    ).json()) as Record<string, string>;
    expect(own["status"]).toBe("received");
    expect(own["scope"]).toMatch(/^api-/);
    const other = await handleRequest(
      new Request(`${BASE}/submissions/scoped-key`, { headers: { authorization: "Bearer token-two" } }),
      store,
      files,
      config,
    );
    expect(other.status).toBe(404);
  });

  test("a submission without a key is rejected", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const res = await handleRequest(
      new Request(`${BASE}/submissions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ household: HOUSEHOLD }),
      }),
      store,
      files,
      config,
    );
    expect(res.status).toBe(400);
  });
});

describe("slow mode", () => {
  test("stores the submission before holding the response", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
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
      files,
      config,
    ).finally(() => {
      responded = true;
    });
    // Poll like a caller would after its own timeout: the receipt must appear
    // while the submit response is still held.
    let seen: Response | null = null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const probe = await handleRequest(new Request(`${BASE}/submissions/${key}`), store, files, config);
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
    const files = new MemoryFileStore();
    const config = testConfig();
    const cookie = await postHousehold(store, files, config);
    const sessionId = cookie.split("=")[1] ?? "";
    const session = await store.getSession(sessionId);
    if (!session) throw new Error("session was not created");
    await store.putSession({ ...session, expiresAt: Date.now() - 1000 });

    const page = await handleRequest(new Request(`${BASE}/apply/documents`, { headers: { cookie } }), store, files, config);
    expect(page.status).toBe(403);
    expect(await page.text()).toContain("timed out");

    const submitForm = new URLSearchParams();
    submitForm.set("key", session.key);
    const submit = await handleRequest(
      new Request(`${BASE}/submissions`, { method: "POST", headers: { cookie }, body: submitForm }),
      store,
      files,
      config,
    );
    expect(submit.status).toBe(403);
    expect((await store.listSubmissions(10)).length).toBe(0);
  });
});

describe("validation", () => {
  test("household requires every field", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const res = await handleRequest(
      new Request(`${BASE}/apply/household`, { method: "POST", body: householdForm({ fullName: "" }) }),
      store,
      files,
      config,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("full legal name");
  });

  test("household size must be a whole number in range", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const res = await handleRequest(
      new Request(`${BASE}/apply/household`, { method: "POST", body: householdForm({ householdSize: "0" }) }),
      store,
      files,
      config,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Household size");
  });

  test("documents require at least one file", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const cookie = await postHousehold(store, files, config);
    const res = await handleRequest(
      new Request(`${BASE}/apply/documents`, { method: "POST", headers: { cookie }, body: new FormData() }),
      store,
      files,
      config,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("at least one document");
  });

  test("documents reject other file types", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const cookie = await postHousehold(store, files, config);
    const form = new FormData();
    form.append("document1", new File(["x"], "note.txt", { type: "text/plain" }));
    const res = await handleRequest(
      new Request(`${BASE}/apply/documents`, { method: "POST", headers: { cookie }, body: form }),
      store,
      files,
      config,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("PDF, PNG or JPG");
  });

  test("documents enforce the size cap", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig({ maxUploadBytes: 10 });
    const cookie = await postHousehold(store, files, config);
    const form = new FormData();
    form.append("document1", pdfFile());
    const res = await handleRequest(
      new Request(`${BASE}/apply/documents`, { method: "POST", headers: { cookie }, body: form }),
      store,
      files,
      config,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("larger than");
  });
});

describe("blocker 5: file bytes in the file store", () => {
  test("a 5 MB upload files and downloads intact", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const cookie = await postHousehold(store, files, config);
    const big = new Uint8Array(5 * 1024 * 1024);
    big.fill(7);
    big[0] = 0x25;
    big[1] = 0x50;
    big[2] = 0x44;
    big[3] = 0x46;
    big[4] = 0x2d;
    await postDocuments(store, files, config, cookie, [new File([big], "big.pdf", { type: "application/pdf" })]);
    const submit = await submitReview(store, files, config, cookie);
    expect(submit.status).toBe(200);
    const confirmation = confirmationFrom(await submit.text());
    const download = await handleRequest(
      new Request(`${BASE}/caseworker/${confirmation}/file/0`),
      store,
      files,
      config,
    );
    expect(download.status).toBe(200);
    const roundTripped = new Uint8Array(await download.arrayBuffer());
    expect(roundTripped.length).toBe(big.length);
    expect(roundTripped[0]).toBe(0x25);
    expect(roundTripped[big.length - 1]).toBe(7);
  });

  test("SQLite rows hold metadata only; bytes live under submission keys", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const cookie = await postHousehold(store, files, config);
    await postDocuments(store, files, config, cookie);
    const submit = await submitReview(store, files, config, cookie);
    expect(submit.status).toBe(200);
    const submissions = await store.listSubmissions(10);
    expect(submissions).toHaveLength(1);
    const filed = submissions[0]!;
    expect(JSON.stringify(filed)).not.toContain("fake-pdf-bytes");
    expect(filed.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(filed.files[0]?.r2key).toMatch(/^submissions\/web\/.+\/1-[0-9a-f]{8}$/);
    const bytes = await files.get(filed.files[0]!.r2key);
    expect(bytes?.type).toBe("application/pdf");
    expect(Buffer.from(bytes!.data).toString()).toBe("fake-pdf-bytes");
    expect([...files.objects.keys()].some((k) => k.startsWith("drafts/"))).toBe(false);
  });

  test("replacing the draft deletes the previous draft objects", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const cookie = await postHousehold(store, files, config);
    await postDocuments(store, files, config, cookie, [pdfFile("first.pdf", "first-bytes")]);
    expect(files.objects.size).toBe(1);
    await postDocuments(store, files, config, cookie, [pdfFile("second.pdf", "second-bytes")]);
    expect(files.objects.size).toBe(1);
    const remaining = await files.get([...files.objects.keys()][0]!);
    expect(Buffer.from(remaining!.data).toString()).toBe("second-bytes");
  });

  test("a conflict deletes the loser's objects and keeps the winner's bytes", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const file = (bytes: string) => ({ name: "paystub.pdf", type: "application/pdf", data: Buffer.from(bytes).toString("base64") });
    const post = (token: string, name: string, bytes: string) =>
      handleRequest(
        new Request(`${BASE}/submissions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ key: "fight-key", household: { ...HOUSEHOLD, fullName: name }, files: [file(bytes)] }),
        }),
        store,
        files,
        config,
      );
    const first = await post("token-one", "Maria Santos", "winner-bytes");
    expect(first.status).toBe(200);
    const second = await post("token-one", "Alex Rivera", "loser-bytes");
    expect(second.status).toBe(409);
    const keys = [...files.objects.keys()];
    expect(keys).toHaveLength(1);
    const kept = await files.get(keys[0]!);
    expect(Buffer.from(kept!.data).toString()).toBe("winner-bytes");
  });
});

describe("caseworker view", () => {
  test("lists submissions with detail and file download", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const empty = await handleRequest(new Request(`${BASE}/caseworker`), store, files, config);
    expect(await empty.text()).toContain("No applications received yet");

    const cookie = await postHousehold(store, files, config);
    await postDocuments(store, files, config, cookie);
    const review = await handleRequest(new Request(`${BASE}/apply/review`, { headers: { cookie } }), store, files, config);
    const submitForm = new URLSearchParams();
    const caseworkerReview = await review.text();
    submitForm.set("key", keyFromReview(caseworkerReview));
    submitForm.set("digest", digestFromReview(caseworkerReview));
    const submit = await handleRequest(
      new Request(`${BASE}/submissions`, { method: "POST", headers: { cookie }, body: submitForm }),
      store,
      files,
      config,
    );
    const confirmation = confirmationFrom(await submit.text());

    const list = await handleRequest(new Request(`${BASE}/caseworker`), store, files, config);
    const listText = await list.text();
    expect(listText).toContain(confirmation);
    expect(listText).toContain("Maria Santos");

    const detail = await handleRequest(new Request(`${BASE}/caseworker/${confirmation}`), store, files, config);
    expect(detail.status).toBe(200);
    expect(await detail.text()).toContain("42 Test Street");

    const file = await handleRequest(new Request(`${BASE}/caseworker/${confirmation}/file/0`), store, files, config);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("application/pdf");
    expect(await file.text()).toBe("fake-pdf-bytes");

    const missing = await handleRequest(new Request(`${BASE}/caseworker/SR-00000000`), store, files, config);
    expect(missing.status).toBe(404);
  });
});

describe("test system labels", () => {
  test("every page says it is a test system", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const cookie = await postHousehold(store, files, config);
    const pages: Request[] = [new Request(`${BASE}/`), new Request(`${BASE}/apply`), new Request(`${BASE}/nope`)];
    for (const req of pages) {
      expect(await (await handleRequest(req, store, files, config)).text()).toContain(TEST_BANNER);
    }
    const authed = [`${BASE}/apply/documents`];
    for (const url of authed) {
      const res = await handleRequest(new Request(url, { headers: { cookie } }), store, files, config);
      expect(await res.text()).toContain(TEST_BANNER);
    }
    await postDocuments(store, files, config, cookie);
    const review = await handleRequest(new Request(`${BASE}/apply/review`, { headers: { cookie } }), store, files, config);
    const reviewText = await review.text();
    expect(reviewText).toContain(TEST_BANNER);
    const submitForm = new URLSearchParams();
    submitForm.set("key", keyFromReview(reviewText));
    submitForm.set("digest", digestFromReview(reviewText));
    const submit = await handleRequest(
      new Request(`${BASE}/submissions`, { method: "POST", headers: { cookie }, body: submitForm }),
      store,
      files,
      config,
    );
    const submitText = await submit.text();
    const confirmation = confirmationFrom(submitText);
    expect(submitText).toContain(TEST_BANNER);
    const list = await handleRequest(new Request(`${BASE}/caseworker`), store, files, config);
    expect(await list.text()).toContain(TEST_BANNER);
    const detail = await handleRequest(new Request(`${BASE}/caseworker/${confirmation}`), store, files, config);
    expect(await detail.text()).toContain(TEST_BANNER);
    const timeout = await handleRequest(new Request(`${BASE}/apply/review`), store, files, config);
    expect(await timeout.text()).toContain(TEST_BANNER);
  });

  test("redirects carry the test banner for clients that do not follow them", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const res = await handleRequest(
      new Request(`${BASE}/apply/household`, { method: "POST", body: householdForm() }),
      store,
      files,
      config,
    );
    expect(res.status).toBe(303);
    expect(await res.text()).toContain(TEST_BANNER);
  });
});
