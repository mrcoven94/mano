import { afterEach, describe, expect, it, vi } from "vitest";
import { MetaModelClient } from "../src/model-client.js";
import { checkLinkSafety } from "../src/link-safety.js";
import { SandboxExecutor } from "../src/gateway/executors.js";
import type { ActionRequest } from "../src/gateway/index.js";

// Production workerd throws "Illegal invocation" when the global fetch is
// called detached from globalThis (as a stored reference), while node and
// miniflare tolerate it. That gap broke every live call in Channels while
// all tests passed. These tests install a strict global fetch that
// reproduces the production behavior, then exercise every default fetchFn
// with no override. Pre-fix they throw exactly like the live calls did;
// post-fix the bound defaults call through.
function installStrictFetch(handler: (url: string) => Response): void {
  function strictFetch(this: unknown, input: unknown): Promise<Response> {
    if (this !== globalThis) {
      throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
    }
    return Promise.resolve(handler(String(input)));
  }
  vi.stubGlobal("fetch", strictFetch);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bound fetch defaults", () => {
  it("completes through MetaModelClient with no fetchFn override", async () => {
    installStrictFetch(() =>
      Response.json({
        status: "completed",
        output: [{ content: [{ type: "output_text", text: "Bound." }] }],
      }),
    );
    const client = new MetaModelClient({ apiKey: "test-key-not-real", maxRetries: 0 });
    const out = await client.complete({ input: "hi", synthetic: true });
    expect(out.text).toBe("Bound.");
    expect(out.model).toBe("muse-spark-1.3-contributor");
  });

  it("checks a link with no fetchFn override", async () => {
    installStrictFetch(() => Response.json({ Answer: [{ data: "93.184.216.34" }] }));
    const result = await checkLinkSafety("https://example.com/page", {});
    expect(result).toEqual({ allowed: true });
  });

  it("executes and reconciles through SandboxExecutor with no fetchFn override", async () => {
    installStrictFetch(() => Response.json({ externalId: "ext-9" }));
    const exec = new SandboxExecutor("https://portal.test");
    const req: ActionRequest = {
      type: "submit",
      recipient: "sandbox-agency",
      purpose: "renewal",
      payload: {},
      idempotencyKey: "key-bound-1",
      actor: "foreground",
      personId: "maria",
      sources: [],
      origin: "person",
    };
    const done = await exec.execute(req);
    expect(done.externalId).toBe("ext-9");
    const found = await exec.check("key-bound-1", "maria");
    expect(found).toEqual({ found: true, externalId: "ext-9" });
  });
});
