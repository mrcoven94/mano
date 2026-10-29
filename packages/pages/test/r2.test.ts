import { describe, expect, it } from "vitest";
import { R2PageStore, r2ConfigFromEnv, signS3Request } from "../src/r2.js";

const BASE = {
  endpoint: "https://example.r2.cloudflarestorage.com",
  bucket: "mano-pages",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "secret-example",
};

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("signS3Request", () => {
  it("signs deterministically under the R2 scope", async () => {
    const args = { ...BASE, method: "GET", key: "pages/v1/abc.bin", payload: null, nowMs: 1_700_000_000_000 };
    const first = await signS3Request(args);
    const second = await signS3Request(args);
    expect(first).toEqual(second);
    expect(first.url).toBe("https://example.r2.cloudflarestorage.com/mano-pages/pages/v1/abc.bin");
    expect(first.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/20231114\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(first.headers["x-amz-content-sha256"]).toBe(EMPTY_SHA256);
    expect(first.headers["x-amz-date"]).toBe("20231114T221320Z");
  });

  it("hashes PUT payloads with sha256", async () => {
    const payload = new TextEncoder().encode("hello pages");
    const signed = await signS3Request({ ...BASE, method: "PUT", key: "k", payload, nowMs: 1_700_000_000_000 });
    const digest = await crypto.subtle.digest("SHA-256", payload as BufferSource);
    const expected = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(signed.headers["x-amz-content-sha256"]).toBe(expected);
  });
});

describe("r2ConfigFromEnv", () => {
  it("reads credentials and defaults the bucket", () => {
    expect(r2ConfigFromEnv({})).toBeNull();
    expect(
      r2ConfigFromEnv({ R2_ENDPOINT: "https://x", R2_ACCESS_KEY_ID: "a", R2_SECRET_ACCESS_KEY: "b" }),
    ).toEqual({ endpoint: "https://x", bucket: "mano-pages", accessKeyId: "a", secretAccessKey: "b" });
  });
});

describe("R2PageStore against a stub server", () => {
  function stubServer() {
    const objects = new Map<string, Uint8Array>();
    const calls: { method: string; url: string; auth: string }[] = [];
    const fetchFn = (async (url: unknown, init?: { method?: string; headers?: Record<string, string>; body?: Uint8Array }) => {
      const href = String(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ method: init?.method ?? "GET", url: href, auth: headers.authorization ?? "" });
      if ((init?.method ?? "GET") === "PUT") {
        objects.set(href, new Uint8Array(init?.body ?? new Uint8Array(0)));
        return new Response("ok", { status: 200 });
      }
      if ((init?.method ?? "GET") === "DELETE") {
        objects.delete(href);
        return new Response(null, { status: 204 });
      }
      const found = objects.get(href);
      if (!found) return new Response("no such key", { status: 404 });
      return new Response(found as BodyInit, { status: 200 });
    }) as typeof fetch;
    return { fetchFn, calls };
  }

  it("puts, gets and deletes through signed requests", async () => {
    const { fetchFn, calls } = stubServer();
    const store = new R2PageStore(BASE, fetchFn, () => 1_700_000_000_000);
    expect(await store.get("pages/v1/missing.bin")).toBeNull();
    await store.put("pages/v1/a.bin", new Uint8Array([7, 7]));
    expect(await store.get("pages/v1/a.bin")).toEqual(new Uint8Array([7, 7]));
    await store.delete("pages/v1/a.bin");
    expect(await store.get("pages/v1/a.bin")).toBeNull();
    expect(calls.map((c) => c.method)).toEqual(["GET", "PUT", "GET", "DELETE", "GET"]);
    for (const call of calls) {
      expect(call.url.startsWith("https://example.r2.cloudflarestorage.com/mano-pages/")).toBe(true);
      expect(call.auth.startsWith("AWS4-HMAC-SHA256 ")).toBe(true);
    }
  });

  it("fails loudly on server errors", async () => {
    const fetchFn = (async () => new Response("down", { status: 500 })) as typeof fetch;
    const store = new R2PageStore(BASE, fetchFn, () => 1_700_000_000_000);
    await expect(store.get("k")).rejects.toThrow("r2 get failed with 500");
    await expect(store.put("k", new Uint8Array([1]))).rejects.toThrow("r2 put failed with 500");
    await expect(store.delete("k")).rejects.toThrow("r2 delete failed with 500");
  });
});

describe("live R2", () => {
  it.skipIf(!process.env.MANO_PAGES_R2_LIVE)("round trips a real object", async () => {
    const config = r2ConfigFromEnv(process.env as Record<string, string | undefined>);
    if (!config) throw new Error("live R2 test needs R2 credentials in env");
    const store = new R2PageStore(config);
    const key = "pages/v1/__healthcheck__.bin";
    const bytes = crypto.getRandomValues(new Uint8Array(64));
    await store.put(key, bytes);
    expect(await store.get(key)).toEqual(bytes);
    await store.delete(key);
    expect(await store.get(key)).toBeNull();
  }, 60_000);
});
