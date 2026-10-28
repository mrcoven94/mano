import { describe, expect, test } from "vitest";
import {
  DEFAULT_CONFIG,
  handleRequest,
  RECEIPT_RETENTION_MS,
  runCleanup,
  STAGED_RETENTION_MS,
  SUBMISSION_RETENTION_MS,
  type PortalConfig,
} from "../src/app";
import { submissionFileKey } from "../src/files";
import { sha256Hex } from "../src/store";
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

const TOKEN = "portal-test-token";
const AUTH = `Bearer ${TOKEN}`;

function testConfig(overrides: Partial<PortalConfig> = {}): PortalConfig {
  return { ...DEFAULT_CONFIG, portalToken: TOKEN, ...overrides };
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

function pdfFile(name = "paystub.pdf", bytes = "%PDF-fake-bytes"): File {
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

    // The web filing belongs to the web scope; an API caller cannot see it.
    const status = await handleRequest(new Request(`${BASE}/submissions/${key}`, { headers: { authorization: AUTH } }), store, files, config);
    expect(status.status).toBe(404);
    expect(((await status.json()) as Record<string, string>)["status"]).toBe("not_found");
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
    expect((await store.countSubmissions())).toBe(0);

    // A fresh review of the current draft submits fine.
    const fresh = await submitReview(store, files, config, cookie);
    expect(fresh.status).toBe(200);
    expect((await store.countSubmissions())).toBe(1);
  });

  test("after filing, the review page shows the receipt instead of the draft", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const cookie = await postHousehold(store, files, config);
    await postDocuments(store, files, config, cookie);
    const submit = await submitReview(store, files, config, cookie);
    const confirmation = confirmationFrom(await submit.text());
    const review = await handleRequest(new Request(`${BASE}/apply/review`, { headers: { cookie } }), store, files, config);
    const reviewText = await review.text();
    expect(reviewText).toContain("already submitted");
    expect(reviewText).toContain(confirmation);
    expect(reviewText).toContain(TEST_BANNER);
    const documents = await handleRequest(new Request(`${BASE}/apply/documents`, { headers: { cookie } }), store, files, config);
    expect(await documents.text()).toContain("already submitted");
  });

  test("filing twice from one session returns the duplicate, not a timeout", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const cookie = await postHousehold(store, files, config);
    await postDocuments(store, files, config, cookie);
    const review = await handleRequest(new Request(`${BASE}/apply/review`, { headers: { cookie } }), store, files, config);
    const reviewText = await review.text();
    const form = new URLSearchParams();
    form.set("key", keyFromReview(reviewText));
    form.set("digest", digestFromReview(reviewText));
    const first = await handleRequest(
      new Request(`${BASE}/submissions`, { method: "POST", headers: { cookie }, body: form }),
      store,
      files,
      config,
    );
    expect(first.status).toBe(200);
    const second = await handleRequest(
      new Request(`${BASE}/submissions`, { method: "POST", headers: { cookie }, body: form }),
      store,
      files,
      config,
    );
    expect(second.status).toBe(200);
    const secondText = await second.text();
    expect(secondText).toContain("Already received");
    expect(confirmationFrom(secondText)).toBe(confirmationFrom(await first.text()));
    expect(await store.countSubmissions()).toBe(1);
  });

  test("the review page speaks like an agency office", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const cookie = await postHousehold(store, files, config);
    await postDocuments(store, files, config, cookie);
    const review = await handleRequest(new Request(`${BASE}/apply/review`, { headers: { cookie } }), store, files, config);
    const reviewText = await review.text();
    expect(reviewText).toContain("Keep this number");
    expect(reviewText).not.toContain("Mano checks");
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
      files: [{ name: "paystub.pdf", type: "application/pdf", data: Buffer.from("%PDF-bytes").toString("base64") }],
    };
    const post = () =>
      handleRequest(
        new Request(`${BASE}/submissions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: AUTH },
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
    expect((await store.countSubmissions())).toBe(1);
  });

  test("concurrent submits under one key file a single receipt", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const packet = {
      key: "race-key",
      household: HOUSEHOLD,
      files: [{ name: "paystub.pdf", type: "application/pdf", data: Buffer.from("%PDF-bytes").toString("base64") }],
    };
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        handleRequest(
          new Request(`${BASE}/submissions`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: AUTH },
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
    expect((await store.countSubmissions())).toBe(1);
  });

  test("unknown key reports not found", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const res = await handleRequest(
      new Request(`${BASE}/submissions/does-not-exist`, { headers: { authorization: AUTH } }),
      store,
      files,
      config,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, string>;
    expect(body["status"]).toBe("not_found");
  });

  test("a different packet under an existing key returns 409 with the received digest", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const file = { name: "paystub.pdf", type: "application/pdf", data: Buffer.from("%PDF-bytes").toString("base64") };
    const post = (household: typeof HOUSEHOLD) =>
      handleRequest(
        new Request(`${BASE}/submissions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: AUTH },
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
    expect((await store.countSubmissions())).toBe(1);
    // The loser shares the winner's file bytes, so its cleanup must spare the winner's objects.
    const download = await handleRequest(
      new Request(`${BASE}/caseworker/${first["confirmationNumber"]}/file/0`, { headers: { authorization: AUTH } }),
      store,
      files,
      config,
    );
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("%PDF-bytes");
  });

  test("the receipt carries the digest the gateway can prove", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const submit = await handleRequest(
      new Request(`${BASE}/submissions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: AUTH },
        body: JSON.stringify({
          key: "digest-key",
          household: HOUSEHOLD,
          files: [{ name: "paystub.pdf", type: "application/pdf", data: Buffer.from("%PDF-bytes").toString("base64") }],
        }),
      }),
      store,
      files,
      config,
    );
    const submitted = (await submit.json()) as Record<string, string>;
    expect(submitted["digest"]).toMatch(/^[0-9a-f]{64}$/);
    const receipt = (await (await handleRequest(new Request(`${BASE}/submissions/digest-key`, { headers: { authorization: AUTH } }), store, files, config)).json()) as Record<
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
    expect((await store.countSubmissions())).toBe(0);
  });

  test("the web and API scopes file the same key independently", async () => {
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
    expect(web.status).toBe(200);
    const file = { name: "paystub.pdf", type: "application/pdf", data: Buffer.from("%PDF-bytes").toString("base64") };
    const api = await handleRequest(
      new Request(`${BASE}/submissions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: AUTH },
        body: JSON.stringify({ key, household: { ...HOUSEHOLD, fullName: "Alex Rivera" }, files: [file] }),
      }),
      store,
      files,
      config,
    );
    expect(api.status).toBe(200);
    const apiBody = (await api.json()) as Record<string, unknown>;
    expect(apiBody["duplicate"]).toBe(false);
    expect(apiBody["scope"]).toMatch(/^api-/);
    expect((await store.countSubmissions())).toBe(2);
  });

  test("a web key is unknown to an API caller, and an API post files it fresh", async () => {
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
    const web = await handleRequest(new Request(`${BASE}/submissions`, { method: "POST", headers: { cookie }, body: form }), store, files, config);
    expect(web.status).toBe(200);
    const unknown = await handleRequest(new Request(`${BASE}/submissions/${key}`, { headers: { authorization: AUTH } }), store, files, config);
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as Record<string, unknown>)["status"]).toBe("not_found");
    const api = await handleRequest(
      new Request(`${BASE}/submissions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: AUTH },
        body: JSON.stringify({
          key,
          household: HOUSEHOLD,
          files: [{ name: "paystub.pdf", type: "application/pdf", data: Buffer.from("%PDF-fake-bytes").toString("base64") }],
        }),
      }),
      store,
      files,
      config,
    );
    expect(api.status).toBe(200);
    const apiBody = (await api.json()) as Record<string, unknown>;
    expect(apiBody["duplicate"]).toBe(false);
    expect(apiBody["scope"]).toMatch(/^api-/);
    const reread = (await (
      await handleRequest(new Request(`${BASE}/submissions/${key}`, { headers: { authorization: AUTH } }), store, files, config)
    ).json()) as Record<string, unknown>;
    expect(reread["status"]).toBe("received");
    expect(reread["confirmationNumber"]).toBe(apiBody["confirmationNumber"]);
  });

  test("malformed JSON is rejected with 400, never a crash", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const post = (body: unknown) =>
      handleRequest(
        new Request(`${BASE}/submissions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: AUTH },
          body: JSON.stringify(body),
        }),
        store,
        files,
        config,
      );
    const cases: Array<[string, unknown, string]> = [
      ["number field", { key: "k", household: { ...HOUSEHOLD, fullName: 42 }, files: [] }, "must be a string"],
      ["string household", { key: "k", household: "x", files: [] }, "must be an object"],
      ["array household", { key: "k", household: [], files: [] }, "must be an object"],
      ["null file", { key: "k", household: HOUSEHOLD, files: [null] }, "name, type and base64 data"],
      ["string file", { key: "k", household: HOUSEHOLD, files: ["x"] }, "name, type and base64 data"],
      ["non-object body", [1, 2], "must be an object"],
    ];
    for (const [name, body, message] of cases) {
      const res = await post(body);
      expect(res.status, name).toBe(400);
      expect(((await res.json()) as Record<string, string>)["error"], name).toContain(message);
    }
    expect(await store.countSubmissions()).toBe(0);
  });

  test("a submission without a key is rejected", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const res = await handleRequest(
      new Request(`${BASE}/submissions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: AUTH },
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
        headers: { "content-type": "application/json", authorization: AUTH },
        body: JSON.stringify({
          key,
          household: HOUSEHOLD,
          files: [{ name: "paystub.pdf", type: "application/pdf", data: Buffer.from("%PDF-bytes").toString("base64") }],
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
      const probe = await handleRequest(new Request(`${BASE}/submissions/${key}`, { headers: { authorization: AUTH } }), store, files, config);
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
    expect((await store.countSubmissions())).toBe(0);
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

  test("documents reject bytes that do not match the declared type", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const cookie = await postHousehold(store, files, config);
    const form = new FormData();
    form.append("document1", new File(["plain text, no signature"], "fake.pdf", { type: "application/pdf" }));
    const res = await handleRequest(
      new Request(`${BASE}/apply/documents`, { method: "POST", headers: { cookie }, body: form }),
      store,
      files,
      config,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("does not look like a PDF file");
    expect(files.objects.size).toBe(0);
    const api = await handleRequest(
      new Request(`${BASE}/submissions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: AUTH },
        body: JSON.stringify({
          key: "k",
          household: HOUSEHOLD,
          files: [{ name: "fake.pdf", type: "application/pdf", data: Buffer.from("plain text, no signature").toString("base64") }],
        }),
      }),
      store,
      files,
      config,
    );
    expect(api.status).toBe(400);
    expect(((await api.json()) as Record<string, string>)["error"]).toContain("does not look like");
  });

  test("documents reject empty files", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const cookie = await postHousehold(store, files, config);
    const form = new FormData();
    form.append("document1", new File([], "empty.pdf", { type: "application/pdf" }));
    const res = await handleRequest(
      new Request(`${BASE}/apply/documents`, { method: "POST", headers: { cookie }, body: form }),
      store,
      files,
      config,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("is empty");
    const api = await handleRequest(
      new Request(`${BASE}/submissions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: AUTH },
        body: JSON.stringify({
          key: "k",
          household: HOUSEHOLD,
          files: [{ name: "empty.pdf", type: "application/pdf", data: "" }],
        }),
      }),
      store,
      files,
      config,
    );
    expect(api.status).toBe(400);
    expect(((await api.json()) as Record<string, string>)["error"]).toContain("is empty");
  });

  test("PNG and JPEG signatures pass", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]).toString("base64");
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64");
    const res = await handleRequest(
      new Request(`${BASE}/submissions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: AUTH },
        body: JSON.stringify({
          key: "images-key",
          household: HOUSEHOLD,
          files: [
            { name: "scan.png", type: "image/png", data: png },
            { name: "photo.jpg", type: "image/jpeg", data: jpg },
          ],
        }),
      }),
      store,
      files,
      config,
    );
    expect(res.status).toBe(200);
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
      new Request(`${BASE}/caseworker/${confirmation}/file/0`, { headers: { authorization: AUTH } }),
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
    const review = await handleRequest(new Request(`${BASE}/apply/review`, { headers: { cookie } }), store, files, config);
    const key = keyFromReview(await review.text());
    const submit = await submitReview(store, files, config, cookie);
    expect(submit.status).toBe(200);
    expect(await store.countSubmissions()).toBe(1);
    const filed = await store.getSubmission("web", key);
    if (!filed) throw new Error("submission was not filed");
    expect(JSON.stringify(filed)).not.toContain("%PDF-");
    expect(filed.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(filed.files[0]?.r2key).toMatch(/^submissions\/web\/.+\/1-[0-9a-f]{64}$/);
    const bytes = await files.get(filed.files[0]!.r2key);
    expect(bytes?.type).toBe("application/pdf");
    expect(Buffer.from(bytes!.data).toString()).toBe("%PDF-fake-bytes");
    expect([...files.objects.keys()].some((k) => k.startsWith("drafts/"))).toBe(false);
  });

  test("replacing the draft deletes the previous draft objects", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const cookie = await postHousehold(store, files, config);
    await postDocuments(store, files, config, cookie, [pdfFile("first.pdf", "%PDF-first-bytes")]);
    expect(files.objects.size).toBe(1);
    await postDocuments(store, files, config, cookie, [pdfFile("second.pdf", "%PDF-second-bytes")]);
    expect(files.objects.size).toBe(1);
    const remaining = await files.get([...files.objects.keys()][0]!);
    expect(Buffer.from(remaining!.data).toString()).toBe("%PDF-second-bytes");
  });

  test("two files sharing a 32-bit hash prefix file and download independently", async () => {
    // Both byte strings hash to 19e758ad...; only the full hash tells them apart.
    const firstBytes = "%PDF-collision-probe-13359";
    const secondBytes = "%PDF-collision-probe-20352";
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const post = (packetBytes: string) =>
      handleRequest(
        new Request(`${BASE}/submissions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: AUTH },
          body: JSON.stringify({
            key: "prefix-key",
            household: HOUSEHOLD,
            files: [{ name: "paystub.pdf", type: "application/pdf", data: Buffer.from(packetBytes).toString("base64") }],
          }),
        }),
        store,
        files,
        config,
      );
    const first = await post(firstBytes);
    expect(first.status).toBe(200);
    const confirmation = ((await first.json()) as Record<string, string>)["confirmationNumber"] ?? "";
    const second = await post(secondBytes);
    expect(second.status).toBe(409);
    const download = await handleRequest(
      new Request(`${BASE}/caseworker/${confirmation}/file/0`, { headers: { authorization: AUTH } }),
      store,
      files,
      config,
    );
    expect(download.status).toBe(200);
    expect(await download.text()).toBe(firstBytes);
    expect(files.objects.size).toBe(1);
    const [hashA, hashB] = await Promise.all([sha256Hex(firstBytes), sha256Hex(secondBytes)]);
    expect(hashA.slice(0, 8)).toBe(hashB.slice(0, 8));
    expect(submissionFileKey("web", "prefix-key", 1, hashA)).not.toBe(submissionFileKey("web", "prefix-key", 1, hashB));
  });

  test("a conflict deletes the loser's objects and keeps the winner's bytes", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const file = (bytes: string) => ({ name: "paystub.pdf", type: "application/pdf", data: Buffer.from(bytes).toString("base64") });
    const post = (name: string, bytes: string) =>
      handleRequest(
        new Request(`${BASE}/submissions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: AUTH },
          body: JSON.stringify({ key: "fight-key", household: { ...HOUSEHOLD, fullName: name }, files: [file(bytes)] }),
        }),
        store,
        files,
        config,
      );
    const first = await post("Maria Santos", "%PDF-winner-bytes");
    expect(first.status).toBe(200);
    const second = await post("Alex Rivera", "%PDF-loser-bytes");
    expect(second.status).toBe(409);
    const keys = [...files.objects.keys()];
    expect(keys).toHaveLength(1);
    const kept = await files.get(keys[0]!);
    expect(Buffer.from(kept!.data).toString()).toBe("%PDF-winner-bytes");
  });
});

describe("blocker 8: scheduled cleanup", () => {
  const DAY = 24 * 60 * 60 * 1000;

  test("expired drafts and their objects are deleted", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const cookie = await postHousehold(store, files, config);
    await postDocuments(store, files, config, cookie);
    expect(files.objects.size).toBe(1);
    const sessionId = cookie.split("=")[1] ?? "";
    const session = await store.getSession(sessionId);
    if (!session) throw new Error("session was not created");
    await store.putSession({ ...session, expiresAt: Date.now() - 1000 });
    const report = await runCleanup(store, files, Date.now());
    expect(report.expiredSessions).toBe(1);
    expect(await store.getSession(sessionId)).toBeNull();
    expect(files.objects.size).toBe(0);
  });

  test("old submissions retire to receipts, then purge", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const filedAt = Date.now();
    const config = testConfig({ now: () => filedAt });
    const submit = await handleRequest(
      new Request(`${BASE}/submissions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: AUTH },
        body: JSON.stringify({
          key: "aging-key",
          household: HOUSEHOLD,
          files: [{ name: "paystub.pdf", type: "application/pdf", data: Buffer.from("%PDF-bytes").toString("base64") }],
        }),
      }),
      store,
      files,
      config,
    );
    const submitted = (await submit.json()) as Record<string, string>;
    expect(files.objects.size).toBe(1);

    const early = await runCleanup(store, files, filedAt + SUBMISSION_RETENTION_MS - DAY);
    expect(early.retiredFiles).toBe(0);
    expect((await store.countSubmissions())).toBe(1);

    const retire = await runCleanup(store, files, filedAt + SUBMISSION_RETENTION_MS + DAY);
    expect(retire.retiredFiles).toBe(1);
    expect(files.objects.size).toBe(0);
    expect((await store.countSubmissions())).toBe(0);

    const receipt = (await (
      await handleRequest(new Request(`${BASE}/submissions/aging-key`, { headers: { authorization: AUTH } }), store, files, config)
    ).json()) as Record<string, unknown>;
    expect(receipt["status"]).toBe("received");
    expect(receipt["retired"]).toBe(true);
    expect(receipt["confirmationNumber"]).toBe(submitted["confirmationNumber"]);
    expect(receipt["digest"]).toBe(submitted["digest"]);

    const purge = await runCleanup(store, files, filedAt + RECEIPT_RETENTION_MS + DAY);
    expect(purge.purgedReceipts).toBe(1);
    const gone = await handleRequest(
      new Request(`${BASE}/submissions/aging-key`, { headers: { authorization: AUTH } }),
      store,
      files,
      config,
    );
    expect(gone.status).toBe(404);
  });
});

describe("blocker 7: size limits run first", () => {
  test("a content-length over the cap is rejected before the body is read", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig({ maxBodyBytes: 64 });
    const res = await handleRequest(
      new Request(`${BASE}/submissions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: AUTH, "content-length": "1000000" },
        body: JSON.stringify({ key: "k" }),
      }),
      store,
      files,
      config,
    );
    expect(res.status).toBe(413);
  });

  test("an oversized body is rejected while streaming", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig({ maxBodyBytes: 64 });
    const api = await handleRequest(
      new Request(`${BASE}/submissions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: AUTH },
        body: JSON.stringify({ key: "k", padding: "x".repeat(1000) }),
      }),
      store,
      files,
      config,
    );
    expect(api.status).toBe(413);
    expect(((await api.json()) as Record<string, string>)["error"]).toContain("larger than");
    const web = await handleRequest(
      new Request(`${BASE}/apply/household`, { method: "POST", body: householdForm({ address: "y".repeat(1000) }) }),
      store,
      files,
      config,
    );
    expect(web.status).toBe(413);
    expect(await web.text()).toContain("Too large");
  });

  test("an oversized encoded file is rejected before decoding", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig({ maxUploadBytes: 10 });
    const res = await handleRequest(
      new Request(`${BASE}/submissions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: AUTH },
        body: JSON.stringify({
          key: "k",
          household: HOUSEHOLD,
          files: [{ name: "big.pdf", type: "application/pdf", data: "A".repeat(1000) }],
        }),
      }),
      store,
      files,
      config,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, string>)["error"]).toContain("larger than");
  });

  test("the file count is checked before entries are touched", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig({ maxUploadFiles: 3 });
    const res = await handleRequest(
      new Request(`${BASE}/submissions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: AUTH },
        body: JSON.stringify({ key: "k", household: HOUSEHOLD, files: [null, null, null, null] }),
      }),
      store,
      files,
      config,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, string>)["error"]).toContain("at most 3");
  });

  test("overlong fields and file names are rejected", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig({ maxFieldLength: 10 });
    const web = await handleRequest(
      new Request(`${BASE}/apply/household`, { method: "POST", body: householdForm({ fullName: "A very long name indeed" }) }),
      store,
      files,
      config,
    );
    expect(web.status).toBe(400);
    expect(await web.text()).toContain("too long");
    const api = await handleRequest(
      new Request(`${BASE}/submissions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: AUTH },
        body: JSON.stringify({
          key: "k",
          household: HOUSEHOLD,
          files: [{ name: `${"n".repeat(201)}.pdf`, type: "application/pdf", data: "eA==" }],
        }),
      }),
      store,
      files,
      testConfig(),
    );
    expect(api.status).toBe(400);
    expect(((await api.json()) as Record<string, string>)["error"]).toContain("too long");
    const cookie = await postHousehold(store, files, testConfig());
    const form = new FormData();
    form.append("document1", new File(["x"], `${"n".repeat(201)}.pdf`, { type: "application/pdf" }));
    const upload = await handleRequest(
      new Request(`${BASE}/apply/documents`, { method: "POST", headers: { cookie }, body: form }),
      store,
      files,
      testConfig(),
    );
    expect(upload.status).toBe(400);
    expect(await upload.text()).toContain("too long");
  });
});

describe("blocker 6: access control", () => {
  test("staff and API routes need the token", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const anonymous = await handleRequest(new Request(`${BASE}/caseworker`), store, files, config);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.text()).toContain("Sign in required");
    const wrong = await handleRequest(
      new Request(`${BASE}/caseworker`, { headers: { authorization: "Bearer wrong" } }),
      store,
      files,
      config,
    );
    expect(wrong.status).toBe(401);
    const api = await handleRequest(
      new Request(`${BASE}/submissions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "k" }),
      }),
      store,
      files,
      config,
    );
    expect(api.status).toBe(401);
    const receipt = await handleRequest(new Request(`${BASE}/submissions/k`), store, files, config);
    expect(receipt.status).toBe(401);
    const allowed = await handleRequest(new Request(`${BASE}/caseworker`, { headers: { authorization: AUTH } }), store, files, config);
    expect(allowed.status).toBe(200);
  });

  test("without a configured token, staff and API access is off but the web flow stays open", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    delete config.portalToken;
    const staff = await handleRequest(new Request(`${BASE}/caseworker`, { headers: { authorization: AUTH } }), store, files, config);
    expect(staff.status).toBe(503);
    const api = await handleRequest(
      new Request(`${BASE}/submissions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: AUTH },
        body: JSON.stringify({ key: "k" }),
      }),
      store,
      files,
      config,
    );
    expect(api.status).toBe(503);
    const cookie = await postHousehold(store, files, config);
    await postDocuments(store, files, config, cookie);
    const submit = await submitReview(store, files, config, cookie);
    expect(submit.status).toBe(200);
  });

  test("the per-IP limit applies to token holders too", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig({ rateLimitPerMinute: 3 });
    for (let i = 0; i < 3; i++) {
      const res = await handleRequest(new Request(`${BASE}/caseworker`, { headers: { authorization: AUTH } }), store, files, config);
      expect(res.status).toBe(200);
    }
    const limited = await handleRequest(new Request(`${BASE}/caseworker`, { headers: { authorization: AUTH } }), store, files, config);
    expect(limited.status).toBe(429);
    expect(await limited.text()).toContain("Too many requests");
    const anon = await handleRequest(new Request(`${BASE}/`), store, files, config);
    expect(anon.status).toBe(429);
    const otherIp = await handleRequest(new Request(`${BASE}/`, { headers: { "cf-connecting-ip": "203.0.113.7" } }), store, files, config);
    expect(otherIp.status).toBe(200);
  });

  test("a retry rejected while all slow slots are busy leaves the filed attachment alone", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const file = { name: "paystub.pdf", type: "application/pdf", data: Buffer.from("%PDF-original").toString("base64") };
    const post = (key: string, slowMs: number) =>
      handleRequest(
        new Request(`${BASE}/submissions?slowMs=${slowMs}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: AUTH },
          body: JSON.stringify({ key, household: HOUSEHOLD, files: [file] }),
        }),
        store,
        files,
        config,
      );
    const first = await post("precious-key", 0);
    expect(first.status).toBe(200);
    const confirmation = ((await first.json()) as Record<string, string>)["confirmationNumber"] ?? "";
    const parked = [0, 1, 2, 3, 4].map((i) => post(`park-${i}`, 800));
    const deadline = Date.now() + 5000;
    while (store.slowLeases.size < 5 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(store.slowLeases.size).toBe(5);
    const retry = await post("precious-key", 800);
    expect(retry.status).toBe(503);
    for (const done of parked) expect((await done).status).toBe(200);
    const download = await handleRequest(
      new Request(`${BASE}/caseworker/${confirmation}/file/0`, { headers: { authorization: AUTH } }),
      store,
      files,
      config,
    );
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("%PDF-original");
  });

  test("slow requests past the concurrency cap get a busy response without filing", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig({ slowMaxConcurrent: 1 });
    const packet = (key: string) => ({
      key,
      household: HOUSEHOLD,
      files: [{ name: "paystub.pdf", type: "application/pdf", data: Buffer.from("%PDF-bytes").toString("base64") }],
    });
    const post = (key: string) =>
      handleRequest(
        new Request(`${BASE}/submissions?slowMs=600`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: AUTH },
          body: JSON.stringify(packet(key)),
        }),
        store,
        files,
        config,
      );
    const first = post("slow-first");
    await new Promise((r) => setTimeout(r, 50));
    const busy = await post("slow-second");
    expect(busy.status).toBe(503);
    expect(((await busy.json()) as Record<string, string>)["error"]).toContain("too many slow");
    expect((await first).status).toBe(200);
    expect((await store.countSubmissions())).toBe(1);
  });

  test("every response carries X-Robots-Tag: noindex", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const home = await handleRequest(new Request(`${BASE}/`), store, files, config);
    expect(home.headers.get("X-Robots-Tag")).toBe("noindex");
    const missing = await handleRequest(new Request(`${BASE}/nope`), store, files, config);
    expect(missing.headers.get("X-Robots-Tag")).toBe("noindex");
    const denied = await handleRequest(new Request(`${BASE}/caseworker`), store, files, config);
    expect(denied.headers.get("X-Robots-Tag")).toBe("noindex");
    const cookie = await postHousehold(store, files, config);
    await postDocuments(store, files, config, cookie);
    const submit = await submitReview(store, files, config, cookie);
    expect(submit.headers.get("X-Robots-Tag")).toBe("noindex");
    const confirmation = confirmationFrom(await submit.text());
    const download = await handleRequest(
      new Request(`${BASE}/caseworker/${confirmation}/file/0`, { headers: { authorization: AUTH } }),
      store,
      files,
      config,
    );
    expect(download.headers.get("X-Robots-Tag")).toBe("noindex");
  });
});

describe("caseworker view", () => {
  test("lists submissions with detail and file download", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const empty = await handleRequest(new Request(`${BASE}/caseworker`, { headers: { authorization: AUTH } }), store, files, config);
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

    const list = await handleRequest(new Request(`${BASE}/caseworker`, { headers: { authorization: AUTH } }), store, files, config);
    const listText = await list.text();
    expect(listText).toContain(confirmation);
    expect(listText).toContain("Maria Santos");

    const detail = await handleRequest(new Request(`${BASE}/caseworker/${confirmation}`, { headers: { authorization: AUTH } }), store, files, config);
    expect(detail.status).toBe(200);
    expect(await detail.text()).toContain("42 Test Street");

    const file = await handleRequest(new Request(`${BASE}/caseworker/${confirmation}/file/0`, { headers: { authorization: AUTH } }), store, files, config);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("application/pdf");
    expect(await file.text()).toBe("%PDF-fake-bytes");

    const missing = await handleRequest(new Request(`${BASE}/caseworker/SR-00000000`, { headers: { authorization: AUTH } }), store, files, config);
    expect(missing.status).toBe(404);
  });

  test("downloads sanitize hostile file names", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const name = 'pay"stub\r\n.pdf';
    const submit = await handleRequest(
      new Request(`${BASE}/submissions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: AUTH },
        body: JSON.stringify({
          key: "hostile-name",
          household: HOUSEHOLD,
          files: [{ name, type: "application/pdf", data: Buffer.from("%PDF-x").toString("base64") }],
        }),
      }),
      store,
      files,
      config,
    );
    expect(submit.status).toBe(200);
    const confirmation = ((await submit.json()) as Record<string, string>)["confirmationNumber"] ?? "";
    const download = await handleRequest(
      new Request(`${BASE}/caseworker/${confirmation}/file/0`, { headers: { authorization: AUTH } }),
      store,
      files,
      config,
    );
    expect(download.status).toBe(200);
    const disposition = download.headers.get("content-disposition") ?? "";
    expect(disposition).not.toContain("\r");
    expect(disposition).not.toContain("\n");
    expect(disposition).toContain('filename="pay_stub__.pdf"');
    expect(disposition).toContain("filename*=UTF-8''");
  });

  test("the list paginates 25 summaries at a time", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    let tick = 1000;
    const config = testConfig({ now: () => tick });
    const file = { name: "paystub.pdf", type: "application/pdf", data: Buffer.from("%PDF-bytes").toString("base64") };
    for (let i = 0; i < 26; i++) {
      tick += 1000;
      const res = await handleRequest(
        new Request(`${BASE}/submissions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: AUTH },
          body: JSON.stringify({ key: `page-key-${i}`, household: { ...HOUSEHOLD, fullName: `Person ${i}` }, files: [file] }),
        }),
        store,
        files,
        config,
      );
      expect(res.status).toBe(200);
    }
    const page1 = await handleRequest(new Request(`${BASE}/caseworker`, { headers: { authorization: AUTH } }), store, files, config);
    const page1Text = await page1.text();
    expect(page1Text).toContain("Page 1 of 2");
    expect(page1Text).toContain("Person 25");
    expect(page1Text).not.toContain("Person 0");
    const page2 = await handleRequest(
      new Request(`${BASE}/caseworker?page=2`, { headers: { authorization: AUTH } }),
      store,
      files,
      config,
    );
    const page2Text = await page2.text();
    expect(page2Text).toContain("Page 2 of 2");
    expect(page2Text).toContain("Person 0");
    const clamped = await handleRequest(
      new Request(`${BASE}/caseworker?page=99`, { headers: { authorization: AUTH } }),
      store,
      files,
      config,
    );
    expect(await clamped.text()).toContain("Page 2 of 2");
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
    const list = await handleRequest(new Request(`${BASE}/caseworker`, { headers: { authorization: AUTH } }), store, files, config);
    expect(await list.text()).toContain(TEST_BANNER);
    const detail = await handleRequest(new Request(`${BASE}/caseworker/${confirmation}`, { headers: { authorization: AUTH } }), store, files, config);
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

/** A file store that fails on demand, to prove deletes and retries stay ordered. */
class FaultyFileStore extends MemoryFileStore {
  failPutsAfter = Number.POSITIVE_INFINITY;
  failDels = false;
  puts = 0;

  override async put(key: string, data: Uint8Array, type: string): Promise<void> {
    if (this.puts >= this.failPutsAfter) throw new Error("R2 put failed");
    this.puts += 1;
    await super.put(key, data, type);
  }

  override async del(keys: string[]): Promise<void> {
    if (this.failDels && keys.length > 0) throw new Error("R2 del failed");
    await super.del(keys);
  }
}

describe("review round 2 item 3: staged bytes are tracked and deletes are ordered", () => {
  test("a lazy expiry deletes the draft bytes and the session row", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const cookie = await postHousehold(store, files, config);
    await postDocuments(store, files, config, cookie);
    expect(files.objects.size).toBe(1);
    const sessionId = cookie.split("=")[1] ?? "";
    const session = await store.getSession(sessionId);
    if (!session) throw new Error("session was not created");
    await store.putSession({ ...session, expiresAt: Date.now() - 1000 });
    const res = await handleRequest(new Request(`${BASE}/apply/review`, { headers: { cookie } }), store, files, config);
    expect(res.status).toBe(403);
    expect(await store.getSession(sessionId)).toBeNull();
    expect(files.objects.size).toBe(0);
  });

  test("a del failure during lazy expiry keeps the row and the bytes for the next attempt", async () => {
    const store = new MemoryStore();
    const files = new FaultyFileStore();
    files.failDels = true;
    const config = testConfig();
    const cookie = await postHousehold(store, files, config);
    await postDocuments(store, files, config, cookie);
    const sessionId = cookie.split("=")[1] ?? "";
    const session = await store.getSession(sessionId);
    if (!session) throw new Error("session was not created");
    await store.putSession({ ...session, expiresAt: Date.now() - 1000 });
    const res = await handleRequest(new Request(`${BASE}/apply/review`, { headers: { cookie } }), store, files, config);
    expect(res.status).toBe(403);
    expect(await store.getSession(sessionId)).not.toBeNull();
    expect(files.objects.size).toBe(1);
    files.failDels = false;
    const retry = await handleRequest(new Request(`${BASE}/apply/review`, { headers: { cookie } }), store, files, config);
    expect(retry.status).toBe(403);
    expect(await store.getSession(sessionId)).toBeNull();
    expect(files.objects.size).toBe(0);
  });

  test("a mid-upload put failure returns 500 and leaves no bytes behind", async () => {
    const store = new MemoryStore();
    const files = new FaultyFileStore();
    files.failPutsAfter = 1;
    const config = testConfig();
    const cookie = await postHousehold(store, files, config);
    const form = new FormData();
    form.append("document1", pdfFile("paystub.pdf", "%PDF-first"));
    form.append("document2", pdfFile("rent.pdf", "%PDF-second"));
    const res = await handleRequest(new Request(`${BASE}/apply/documents`, { method: "POST", headers: { cookie }, body: form }), store, files, config);
    expect(res.status).toBe(500);
    expect(files.objects.size).toBe(0);
    const sessionId = cookie.split("=")[1] ?? "";
    expect((await store.getSession(sessionId))?.files).toEqual([]);
  });

  test("a copy failure files nothing, and a retry files clean the first time", async () => {
    const store = new MemoryStore();
    const files = new FaultyFileStore();
    files.failPutsAfter = 1;
    const filedAt = Date.now();
    const config = testConfig({ now: () => filedAt });
    const packet = {
      key: "copy-fail-key",
      household: HOUSEHOLD,
      files: [{ name: "paystub.pdf", type: "application/pdf", data: Buffer.from("%PDF-bytes").toString("base64") }],
    };
    const post = () =>
      handleRequest(
        new Request(`${BASE}/submissions`, { method: "POST", headers: { "content-type": "application/json", authorization: AUTH }, body: JSON.stringify(packet) }),
        store,
        files,
        config,
      );
    const first = await post();
    expect(first.status).toBe(500);
    expect((await first.json()) as Record<string, unknown>).not.toHaveProperty("confirmationNumber");
    const status = await handleRequest(new Request(`${BASE}/submissions/copy-fail-key`, { headers: { authorization: AUTH } }), store, files, config);
    expect(status.status).toBe(404);
    expect(((await status.json()) as Record<string, unknown>)["status"]).toBe("not_found");
    expect(await store.countSubmissions()).toBe(0);
    files.failPutsAfter = Number.POSITIVE_INFINITY;
    const again = await post();
    expect(again.status).toBe(200);
    const retry = (await again.json()) as Record<string, unknown>;
    expect(retry["duplicate"]).toBe(false);
    const confirmation = retry["confirmationNumber"] as string;
    const download = await handleRequest(new Request(`${BASE}/caseworker/${confirmation}/file/0`, { headers: { authorization: AUTH } }), store, files, config);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("%PDF-bytes");
  });

  test("cleanup deletes file bytes before rows, so a del failure keeps both for the next run", async () => {
    const store = new MemoryStore();
    const files = new FaultyFileStore();
    const filedAt = Date.now();
    const config = testConfig({ now: () => filedAt });
    const res = await handleRequest(
      new Request(`${BASE}/submissions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: AUTH },
        body: JSON.stringify({
          key: "aging-key",
          household: HOUSEHOLD,
          files: [{ name: "paystub.pdf", type: "application/pdf", data: Buffer.from("%PDF-bytes").toString("base64") }],
        }),
      }),
      store,
      files,
      config,
    );
    expect(res.status).toBe(200);
    const scope = `api-${await sha256Hex(TOKEN)}`;
    files.failDels = true;
    await expect(runCleanup(store, files, filedAt + SUBMISSION_RETENTION_MS + 1000)).rejects.toThrow("R2 del failed");
    expect(await store.countSubmissions()).toBe(1);
    expect(files.objects.size).toBeGreaterThan(0);
    files.failDels = false;
    const report = await runCleanup(store, files, filedAt + SUBMISSION_RETENTION_MS + 1000);
    expect(report.retiredFiles).toBe(1);
    expect(await store.countSubmissions()).toBe(0);
    expect(await store.getReceipt(scope, "aging-key")).not.toBeNull();
    expect([...files.objects.keys()].some((k) => k.startsWith("submissions/"))).toBe(false);
  });

  test("cleanup sweeps abandoned staging older than an hour and leaves fresh staging alone", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const now = Date.now();
    await files.put("staging/old-attempt/0-abc", new TextEncoder().encode("%PDF-old"), "application/pdf");
    await files.put("staging/new-attempt/0-def", new TextEncoder().encode("%PDF-new"), "application/pdf");
    await store.trackStaged([
      { key: "staging/old-attempt/0-abc", createdAt: now - STAGED_RETENTION_MS - 1000 },
      { key: "staging/new-attempt/0-def", createdAt: now },
    ]);
    const report = await runCleanup(store, files, now);
    expect(report.sweptStaged).toBe(1);
    expect(await files.get("staging/old-attempt/0-abc")).toBeNull();
    expect(await files.get("staging/new-attempt/0-def")).not.toBeNull();
    expect(await store.listStaleStaged(now - STAGED_RETENTION_MS)).toEqual([]);
    expect(store.stagedObjects.has("staging/new-attempt/0-def")).toBe(true);
  });
});

describe("review round 2 item 4: idempotency survives retirement", () => {
  const packet = {
    key: "retire-key",
    household: HOUSEHOLD,
    files: [{ name: "paystub.pdf", type: "application/pdf", data: Buffer.from("%PDF-bytes").toString("base64") }],
  };

  function post(store: MemoryStore, files: MemoryFileStore, config: PortalConfig, body: unknown = packet) {
    return handleRequest(
      new Request(`${BASE}/submissions`, { method: "POST", headers: { "content-type": "application/json", authorization: AUTH }, body: JSON.stringify(body) }),
      store,
      files,
      config,
    );
  }

  test("an identical retry after retirement returns the original receipt", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const filedAt = Date.now();
    const config = testConfig({ now: () => filedAt });
    const original = ((await (await post(store, files, config)).json()) as Record<string, string>)["confirmationNumber"] ?? "";
    expect(original).not.toBe("");
    await runCleanup(store, files, filedAt + SUBMISSION_RETENTION_MS + 1000);
    expect(await store.countSubmissions()).toBe(0);
    const retry = await post(store, files, config);
    expect(retry.status).toBe(200);
    const body = (await retry.json()) as Record<string, unknown>;
    expect(body["duplicate"]).toBe(true);
    expect(body["retired"]).toBe(true);
    expect(body["confirmationNumber"]).toBe(original);
    expect(await store.countSubmissions()).toBe(0);
  });

  test("a changed packet after retirement returns 409 with the original receipt", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const filedAt = Date.now();
    const config = testConfig({ now: () => filedAt });
    const original = ((await (await post(store, files, config)).json()) as Record<string, string>)["confirmationNumber"] ?? "";
    await runCleanup(store, files, filedAt + SUBMISSION_RETENTION_MS + 1000);
    const changed = await post(store, files, config, { ...packet, household: { ...HOUSEHOLD, fullName: "Someone Else" } });
    expect(changed.status).toBe(409);
    const body = (await changed.json()) as Record<string, { confirmationNumber: string }>;
    expect(body["received"]?.confirmationNumber).toBe(original);
    expect(await store.countSubmissions()).toBe(0);
  });
});

describe("review round 2 should-fix: a second application mints a fresh session", () => {
  test("two filings with one cookie get separate sessions, keys, and confirmations", async () => {
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = testConfig();
    const cookie = await postHousehold(store, files, config);
    await postDocuments(store, files, config, cookie);
    const firstSubmit = await submitReview(store, files, config, cookie);
    expect(firstSubmit.status).toBe(200);
    const firstConfirmation = confirmationFrom(await firstSubmit.text());
    const again = await handleRequest(
      new Request(`${BASE}/apply/household`, { method: "POST", headers: { cookie }, body: householdForm({ fullName: "Second Applicant" }) }),
      store,
      files,
      config,
    );
    expect(again.status).toBe(303);
    const cookie2 = cookieFrom(again);
    expect(cookie2).not.toBe(cookie);
    await postDocuments(store, files, config, cookie2);
    const secondSubmit = await submitReview(store, files, config, cookie2);
    expect(secondSubmit.status).toBe(200);
    const secondConfirmation = confirmationFrom(await secondSubmit.text());
    expect(secondConfirmation).not.toBe(firstConfirmation);
    expect(await store.countSubmissions()).toBe(2);
  });
});
