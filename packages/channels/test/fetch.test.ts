import { afterEach, describe, expect, it, vi } from "vitest";
import { BlooioChannel } from "../src/blooio.js";
import { SparkResponder } from "../src/responder.js";
import { LinkChecker } from "../src/links.js";

// Production workerd throws "Illegal invocation" when the global fetch
// is called detached from globalThis (as a stored reference), while
// node and miniflare tolerate it. These tests install a strict global
// fetch that reproduces the production behavior, then exercise every
// default fetchFn with no override. Pre-fix they throw exactly like
// the live cron did; post-fix the bound defaults call through.
function installStrictFetch(handler: (url: string) => Response): void {
  function strictFetch(this: unknown, input: unknown): Promise<Response> {
    if (this !== globalThis) throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
    return Promise.resolve(handler(String(input)));
  }
  vi.stubGlobal("fetch", strictFetch);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bound fetch defaults", () => {
  it("sends through BlooioChannel with no fetchFn override", async () => {
    installStrictFetch(() => Response.json({ id: "msg_bound_1", chat_id: "chat_bound" }, { status: 201 }));
    const channel = new BlooioChannel({ apiKey: "k", channelId: "ch_bound" });
    const result = await channel.send({ to: "+15550001001", chatId: "chat_bound", text: "Hi", idempotencyKey: "key-bound-1" });
    expect(result.messageId).toBe("msg_bound_1");
  });

  it("lists events through BlooioChannel with no fetchFn override", async () => {
    installStrictFetch(() => Response.json({ data: [], next_cursor: null }));
    const channel = new BlooioChannel({ apiKey: "k", channelId: "ch_bound" });
    await expect(channel.listEvents(null, 10)).resolves.toEqual({ events: [], nextCursor: null });
  });

  it("responds through SparkResponder with no fetchFn override", async () => {
    installStrictFetch(() =>
      Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Bound." }] }] }),
    );
    const responder = new SparkResponder({ apiKey: "k", model: "test-model-standard" });
    const result = await responder.respond({ texts: ["Hi"], attachmentCount: 0 });
    expect(result.text).toBe("Bound.");
  });

  it("checks links through LinkChecker with no fetchFn override", async () => {
    installStrictFetch(() => Response.json({ Status: 0, Answer: [{ data: "93.184.216.34" }] }));
    const checker = new LinkChecker();
    const checked = await checker.checkUrl("https://example.com");
    expect(checked.ok).toBe(true);
  });
});
