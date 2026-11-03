import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { PHOTO_FORMAT_TEXT, StandInResponder } from "@mano/channels";
import { sniffMediaType, storedForm, type PhotoConverter } from "../src/files.js";
import { SandboxExecutor, PORTAL_DECLARATION } from "../../engine/src/gateway/executors.js";
import type { ActionRequest } from "../../engine/src/gateway/types.js";
import { DEFAULT_CONFIG, handleRequest } from "../../sandbox-portal/src/app";
import { MemoryFileStore, MemoryStore } from "../../sandbox-portal/test/memory-store";
import { CRISIS_LINE } from "@mano/persona";
import { MemoryStore as ConversationMemoryStore, type AttachmentChoice } from "../src/store.js";
import { SqlConversationStore } from "../src/store-sql.js";
import { inboundEvent, makeHarness, runTurnAfterBatch, sqliteStorage, type Harness } from "./helpers.js";

// letter.heic: a synthetic letter drawn in code and saved as HEIC by
// macOS sips, the encoder an iPhone uses. letter-images.jpg: what the
// real Cloudflare Images binding returned for it (4096 scale-down, JPEG
// quality 85), recorded on November 3, 2026.
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const HEIC = fixture("letter.heic");
const IMAGES_JPEG = fixture("letter-images.jpg");
// The same file as HEIF: only the ftyp brand differs.
const HEIF = (() => {
  const b = HEIC.slice();
  b.set(new TextEncoder().encode("mif1"), 8);
  return b;
})();
const WEBP = new Uint8Array([...new TextEncoder().encode("RIFF"), 0x24, 0, 0, 0, ...new TextEncoder().encode("WEBPVP8 ")]);

const recordedImages: PhotoConverter = { toJpeg: async () => IMAGES_JPEG };

describe("the media type comes from the bytes", () => {
  it.each([
    ["an iPhone HEIC", HEIC, "image/heic"],
    ["a HEIF", HEIF, "image/heif"],
    ["a WebP", WEBP, "image/webp"],
    ["a JPEG", IMAGES_JPEG, "image/jpeg"],
    ["a PNG", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), "image/png"],
    ["a PDF", new TextEncoder().encode("%PDF-1.4 synthetic"), "application/pdf"],
    ["anything else", new TextEncoder().encode("synthetic-photo-bytes"), null],
  ])("%s", (_name, bytes, type) => {
    expect(sniffMediaType(bytes)).toBe(type);
  });
});

describe("what is stored for a texted photo", () => {
  it("stores the JPEG copy of a HEIC, even when the provider labels it a JPEG", async () => {
    const out = await storedForm(HEIC, "image/jpeg", recordedImages);
    expect(out).toEqual({ bytes: IMAGES_JPEG, mimeType: "image/jpeg", converted: true });
  });

  it("converts HEIF and WebP the same way", async () => {
    expect((await storedForm(HEIF, "image/heif", recordedImages)).mimeType).toBe("image/jpeg");
    expect((await storedForm(WEBP, "image/webp", recordedImages)).mimeType).toBe("image/jpeg");
  });

  it("stores a JPEG or PNG as sent, without converting", async () => {
    let calls = 0;
    const counting: PhotoConverter = { toJpeg: async () => (calls++, IMAGES_JPEG) };
    expect(await storedForm(IMAGES_JPEG, "image/heic", counting)).toEqual({ bytes: IMAGES_JPEG, mimeType: "image/jpeg", converted: false });
    expect(calls).toBe(0);
  });

  it("keeps a file it cannot read under the provider's label", async () => {
    const clip = new TextEncoder().encode("synthetic-clip");
    expect(await storedForm(clip, "video/mp4", recordedImages)).toEqual({ bytes: clip, mimeType: "video/mp4", converted: false });
  });

  it.each(["image/x-maria-testcase", "application/maria-testcase", 'video/mp4x; name="Maria Testcase.mov"'])(
    "stores unknown bytes labeled %s as the generic type",
    async (label) => {
      const gif = new TextEncoder().encode("GIF89a synthetic");
      expect((await storedForm(gif, label, recordedImages)).mimeType).toBe("application/octet-stream");
    },
  );

  it.each([
    ["no converter", null, "no_converter"],
    ["the converter fails", { toJpeg: async () => Promise.reject(new Error("IMAGES_TRANSFORM_ERROR 9516")) }, "failed"],
    ["the converter returns something that is not a JPEG", { toJpeg: async () => HEIC }, "failed"],
  ] as const)("keeps the HEIC as sent when %s", async (_name, converter, reason) => {
    const out = await storedForm(HEIC, "image/heic", converter);
    expect(out).toEqual({ bytes: HEIC, mimeType: "image/heic", converted: false, unconverted: reason });
  });

  it("keeps the HEIC as sent when the copy is larger than a stored file may be", async () => {
    const out = await storedForm(HEIC, "image/heic", recordedImages, IMAGES_JPEG.byteLength - 1);
    expect(out.unconverted).toBe("too_large");
    expect(out.bytes).toBe(HEIC);
  });
});

describe("a HEIC letter texted from an iPhone", () => {
  const CLEAN_DOH = JSON.stringify({ Status: 0, Answer: [{ name: "cdn.example.test.", type: 1, data: "203.0.113.7" }] });
  const MEDIA = { mediaHosts: ["cdn.example.test"] };
  const heicFetch = (async (url: unknown) =>
    String(url).includes("dns-query")
      ? new Response(CLEAN_DOH, { status: 200, headers: { "content-type": "application/dns-json" } })
      : new Response(HEIC, { status: 200, headers: { "content-type": "image/heic" } })) as typeof fetch;
  const reader = () => Object.assign(new StandInResponder(["This is your renewal letter."]), { readsPhotos: true as const });

  async function text(photoConverter: PhotoConverter | null) {
    const responder = reader();
    const h = makeHarness({ fetchFn: heicFetch, responder, config: MEDIA, photoConverter });
    await h.runner.handleEvent(
      inboundEvent({
        id: "evt_heic",
        occurredAtMs: h.now,
        text: "",
        attachments: [{ url: "https://cdn.example.test/IMG_0001.HEIC", mediaType: "image/heic", size: HEIC.byteLength }],
      }),
      "webhook",
    );
    await runTurnAfterBatch(h);
    const [[id, stored]] = [...h.documents.docs.entries()];
    return { h, responder, id, stored, reply: h.channel.sends.map((s) => s.text).join("\n") };
  }

  // The real sandbox portal (apps/sandbox-portal) behind Engine's executor,
  // as in Engine's own portal contract test.
  function portal() {
    const config = { ...DEFAULT_CONFIG, portalToken: "portal-test-token" };
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const posts: { files: { type: string }[] }[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") posts.push(JSON.parse(init.body as string));
      return handleRequest(new Request(url, init), store, files, config);
    }) as typeof fetch;
    return { posts, executor: new SandboxExecutor("https://portal.test", 1000, fetchFn, "portal-test-token") };
  }

  function renewal(document: Uint8Array): ActionRequest {
    return {
      type: "submit",
      recipient: "sandbox-agency-portal",
      purpose: "Food benefits renewal in the sandbox agency portal",
      payload: {
        caseNumber: "WA-SNAP-0042117",
        fullName: "Maria Testcase",
        dateOfBirth: "1984-03-12",
        address: "100 Sample St, Tacoma, WA 98402",
        phone: "253-555-0142",
        householdSize: "3",
        monthlyIncome: "2150",
        declaration: PORTAL_DECLARATION,
      },
      idempotencyKey: "agent:g0:turn-1:d0",
      actor: "foreground",
      personId: "person-maria",
      document: { bytesB64: Buffer.from(document).toString("base64"), hash: "h" },
      answeredBy: "person-maria",
    };
  }

  it("is stored as its JPEG copy, read as a JPEG, and the sandbox portal files it", async () => {
    const { h, responder, id, stored, reply } = await text(recordedImages);
    expect(stored.bytes).toEqual(IMAGES_JPEG);
    expect(responder.prompts[0].documents).toEqual([{ id, mimeType: "image/jpeg" }]);
    expect(reply).not.toContain(PHOTO_FORMAT_TEXT);
    expect(h.lines.join("\n")).toMatch(/attachment_media.*"declared":"image\/heic".*"stored":"image\/jpeg"/);

    const { posts, executor } = portal();
    expect(executor.refuse(renewal(stored.bytes))).toBeNull();
    const receipt = await executor.execute(renewal(stored.bytes));
    expect(receipt.externalId).toMatch(/\S/);
    expect(posts[0].files.map((f) => f.type)).toEqual(["image/jpeg"]);
  });

  it("when no copy can be made, is kept as sent for reading, and Mano asks for a screenshot now", async () => {
    const { responder, id, stored, reply } = await text({ toJpeg: async () => Promise.reject(new Error("IMAGES_TRANSFORM_ERROR 9516")) });
    expect(stored.bytes).toEqual(HEIC);
    expect(responder.prompts[0].documents).toEqual([{ id, mimeType: "image/heic" }]);
    expect(reply).toContain("This is your renewal letter.");
    expect(reply).toContain("please send a screenshot of the photo instead");
    // What the portal would say at filing time, which Mano no longer waits for.
    expect(portal().executor.refuse(renewal(stored.bytes))).toBe("The sandbox agency portal takes PDF, PNG or JPG documents only.");
  });

  it("asks the same without a converter, as on a deploy with no Images binding", async () => {
    const { stored, reply } = await text(null);
    expect(stored.bytes).toEqual(HEIC);
    expect(reply).toContain("please send a screenshot of the photo instead");
  });
});

// The turn dies after the photo is stored and before its answer is saved,
// as when a Worker is evicted, and the next alarm replays it.
class DiesOnceBeforeAnswer extends ConversationMemoryStore {
  dies = true;
  override updateTurnAnswer(...args: Parameters<ConversationMemoryStore["updateTurnAnswer"]>): void {
    if (this.dies) {
      this.dies = false;
      throw new Error("evicted");
    }
    super.updateTurnAnswer(...args);
  }
}

describe("a replayed turn stores each photo once, in the form it chose first", () => {
  const CLEAN_DOH = JSON.stringify({ Status: 0, Answer: [{ name: "cdn.example.test.", type: 1, data: "203.0.113.7" }] });
  const heicFetch = (async (url: unknown) =>
    String(url).includes("dns-query")
      ? new Response(CLEAN_DOH, { status: 200, headers: { "content-type": "application/dns-json" } })
      : new Response(HEIC, { status: 200, headers: { "content-type": "image/heic" } })) as typeof fetch;

  // A converter that answers each call from the list, counting calls.
  function scripted(...answers: ("jpeg" | "error")[]): PhotoConverter & { calls: number } {
    const c = {
      calls: 0,
      toJpeg: async () => {
        const answer = answers[c.calls++] ?? "error";
        if (answer === "error") throw new Error("IMAGES_TRANSFORM_ERROR 9516");
        return IMAGES_JPEG;
      },
    };
    return c;
  }

  async function replayed(converter: PhotoConverter, store = new DiesOnceBeforeAnswer()) {
    const responder = Object.assign(new StandInResponder(["This is your renewal letter."]), { readsPhotos: true as const });
    const h: Harness = makeHarness({ fetchFn: heicFetch, responder, config: { mediaHosts: ["cdn.example.test"] }, photoConverter: converter, store });
    await h.runner.handleEvent(
      inboundEvent({ id: "evt_heic", occurredAtMs: h.now, text: "", attachments: [{ url: "https://cdn.example.test/IMG_0002.HEIC", mediaType: "image/heic" }] }),
      "webhook",
    );
    h.advance(h.batchMs + 100);
    const first = await h.runner.runDueTurn();
    h.advance(60_000);
    const second = await h.runner.runDueTurn();
    return { h, responder, first, second, reply: h.channel.sends.map((s) => s.text).join("\n") };
  }

  it("kept as sent, then the copy would work on replay: still one HEIC, the same ask, no second conversion", async () => {
    const converter = scripted("error", "jpeg");
    const { h, responder, first, second, reply } = await replayed(converter);
    expect([first, second]).toEqual(["retry", "ran"]);
    expect(converter.calls).toBe(1);
    expect([...h.documents.docs.values()].map((d) => d.bytes)).toEqual([HEIC]);
    expect(responder.prompts.at(-1)?.documents?.map((d) => d.mimeType)).toEqual(["image/heic"]);
    expect(reply).toContain(PHOTO_FORMAT_TEXT);
  });

  it("copied, then Images fails on replay: still one JPEG, no original beside it, no ask", async () => {
    const converter = scripted("jpeg", "error");
    const { h, responder, first, second, reply } = await replayed(converter);
    expect([first, second]).toEqual(["retry", "ran"]);
    expect(converter.calls).toBe(1);
    expect([...h.documents.docs.values()].map((d) => d.bytes)).toEqual([IMAGES_JPEG]);
    expect(responder.prompts.at(-1)?.documents?.map((d) => d.mimeType)).toEqual(["image/jpeg"]);
    expect(reply).not.toContain(PHOTO_FORMAT_TEXT);
  });

  it("chose the copy but died during the upload: the replay makes the copy again, or stores nothing, never the original", async () => {
    const seeded = () => {
      const store = new ConversationMemoryStore();
      store.saveAttachmentChoice({
        turn: 1, index: 0, generation: 0, documentId: "g0t1i0-chosen", mimeType: "image/jpeg", converted: true, unfileable: false,
        byteKey: "seeded:1:0", sizeBytes: IMAGES_JPEG.byteLength, state: "chosen",
      });
      return store;
    };
    const works = await replayed(scripted("jpeg"), seeded() as DiesOnceBeforeAnswer);
    expect([...works.h.documents.docs.entries()].map(([id, d]) => [id, d.bytes])).toEqual([["g0t1i0-chosen", IMAGES_JPEG]]);
    const fails = await replayed(scripted("error"), seeded() as DiesOnceBeforeAnswer);
    expect(fails.h.documents.docs.size).toBe(0);
    expect(fails.h.lines.join("\n")).toContain('"reason":"copy_again"');
  });
});

describe("the screenshot ask", () => {
  const CLEAN_DOH = JSON.stringify({ Status: 0, Answer: [{ name: "cdn.example.test.", type: 1, data: "203.0.113.7" }] });
  const heicFetch = (async (url: unknown) =>
    String(url).includes("dns-query")
      ? new Response(CLEAN_DOH, { status: 200, headers: { "content-type": "application/dns-json" } })
      : new Response(HEIC, { status: 200, headers: { "content-type": 'image/heic; name="Maria Testcase renewal letter.heic"' } })) as typeof fetch;
  const failing: PhotoConverter = { toJpeg: async () => Promise.reject(new Error("IMAGES_TRANSFORM_ERROR 9516")) };
  const LONG = Array.from({ length: 4 }, (_, i) => `Line ${i + 1} about the synthetic letter. ${"It explains the renewal in plain words. ".repeat(14)}`.trim()).join("\n");

  async function texted(text: string, reply: string) {
    const responder = Object.assign(new StandInResponder([reply]), { readsPhotos: true as const });
    const h = makeHarness({ fetchFn: heicFetch, responder, config: { mediaHosts: ["cdn.example.test"] }, photoConverter: failing });
    await h.runner.handleEvent(
      inboundEvent({
        id: "evt_heic_long",
        occurredAtMs: h.now,
        text,
        attachments: [{ url: "https://cdn.example.test/IMG_0003.HEIC", mediaType: 'image/heic; name="Maria Testcase renewal letter.heic"' }],
      }),
      "webhook",
    );
    await runTurnAfterBatch(h);
    return h;
  }

  it("survives an answer long enough to fill every bubble", async () => {
    expect(LONG.split("\n").every((line) => line.length > 550)).toBe(true);
    const h = await texted("What does this say?", LONG);
    const sent = h.channel.sends.map((s) => s.text);
    expect(sent.at(-1)).toBe(PHOTO_FORMAT_TEXT);
    expect(sent.join(" ")).toContain("Line 4 about the synthetic letter.");
  });

  it("never rides on a crisis reply", async () => {
    const h = await texted("I am in immediate danger. My landlord is outside.", LONG);
    const sent = h.channel.sends.map((s) => s.text);
    expect(sent).toContain(CRISIS_LINE);
    expect(sent.join("\n")).not.toContain(PHOTO_FORMAT_TEXT);
  });

  it("logs only bare, known media types, never the file name the label carries", async () => {
    const h = await texted("What does this say?", "This is your renewal letter.");
    const logs = h.lines.join("\n");
    expect(logs).toContain('"declared":"image/heic"');
    expect(logs).not.toContain("Maria");
    expect(logs).not.toContain("renewal letter.heic");
    expect(JSON.stringify((h.responder as StandInResponder).prompts)).not.toContain("Maria Testcase");
  });
});

describe("attachment choices in the conversation's SQLite", () => {
  const choice: AttachmentChoice = {
    turn: 3, index: 1, generation: 0, documentId: "g0t3i1-abc", mimeType: "image/heic", converted: false, unfileable: true,
    byteKey: "h:3:0", sizeBytes: 1234, state: "chosen",
  };

  it("survives a restart, and is dropped when its turn finishes or the conversation is deleted", () => {
    const db = new DatabaseSync(":memory:");
    new SqlConversationStore(sqliteStorage(db)).saveAttachmentChoice(choice);
    const reopened = new SqlConversationStore(sqliteStorage(db));
    expect(reopened.attachmentChoice(3, 1)).toEqual(choice);
    reopened.saveAttachmentChoice({ ...choice, state: "stored" });
    expect(reopened.attachmentChoice(3, 1)?.state).toBe("stored");
    reopened.finishTurn(3, 0);
    expect(reopened.attachmentChoice(3, 1)).toBeNull();
    reopened.saveAttachmentChoice(choice);
    reopened.wipe(0);
    expect(reopened.attachmentChoice(3, 1)).toBeNull();
  });
});

describe("labels, deletes and byte counts around a stored photo", () => {
  const CLEAN_DOH = JSON.stringify({ Status: 0, Answer: [{ name: "cdn.example.test.", type: 1, data: "203.0.113.7" }] });
  const serve = (bytes: Uint8Array, type: string) =>
    (async (url: unknown) =>
      String(url).includes("dns-query")
        ? new Response(CLEAN_DOH, { status: 200, headers: { "content-type": "application/dns-json" } })
        : new Response(bytes, { status: 200, headers: { "content-type": type } })) as typeof fetch;

  function harness(fetchFn: typeof fetch, store?: ConversationMemoryStore) {
    const responder = Object.assign(new StandInResponder(["This is your renewal letter."]), { readsPhotos: true as const });
    return makeHarness({ fetchFn, responder, config: { mediaHosts: ["cdn.example.test"] }, photoConverter: recordedImages, store });
  }

  async function sendPhoto(h: Harness, mediaType: string) {
    await h.runner.handleEvent(
      inboundEvent({ id: "evt_r3", occurredAtMs: h.now, text: "", attachments: [{ url: "https://cdn.example.test/IMG_0004", mediaType }] }),
      "webhook",
    );
    h.advance(h.batchMs + 100);
  }

  it.each([
    ["a GIF served as image/x-maria-testcase", "image/x-maria-testcase"],
    ["unknown bytes served as application/maria-testcase", "application/maria-testcase"],
  ])("%s reaches the agent as the generic type, with no name in it", async (_name, type) => {
    const h = harness(serve(new TextEncoder().encode("GIF89a synthetic"), type));
    await sendPhoto(h, type);
    expect(await h.runner.runDueTurn()).toBe("ran");
    const prompts = JSON.stringify((h.responder as StandInResponder).prompts);
    expect(prompts).toContain('"mimeType":"application/octet-stream"');
    expect(prompts.toLowerCase()).not.toContain("maria");
    expect(h.lines.join("\n").toLowerCase()).not.toContain("maria");
  });

  it("a delete that lands while the upload is in flight leaves no choice behind", async () => {
    const h = harness(serve(HEIC, "image/heic"));
    const put = h.documents.put.bind(h.documents);
    h.documents.put = async (doc) => {
      const ok = await put(doc);
      h.store.wipe(h.now);
      return ok;
    };
    await sendPhoto(h, "image/heic");
    expect(await h.runner.runDueTurn()).toBe("stopped");
    expect(h.store.attachmentChoice(1, 0)).toBeNull();
    expect(h.store.meta().byteDayCount).toBe(0);
  });

  const usedGlobally = (h: Harness): number => h.ledger.byteReserve("probe", 0).bytesUsed;

  it("evicted after the photo is stored and counted but before the global settle: the replay settles it once", async () => {
    const store = new DiesOnceBeforeAnswer();
    const h = harness(serve(HEIC, "image/heic"), store);
    const settle = h.ledger.byteSettle.bind(h.ledger);
    let failed = false;
    h.ledger.byteSettle = (key, bytes) => {
      if (!failed) {
        failed = true;
        throw new Error("evicted");
      }
      return settle(key, bytes);
    };
    await sendPhoto(h, "image/heic");
    expect(await h.runner.runDueTurn()).toBe("retry");
    expect(store.attachmentChoice(1, 0)?.state).toBe("stored");
    expect(store.meta().byteDayCount).toBe(IMAGES_JPEG.byteLength);
    expect(usedGlobally(h)).toBe(0);
    h.advance(60_000);
    expect(await h.runner.runDueTurn()).toBe("ran");
    expect(h.documents.docs.size).toBe(1);
    expect(store.meta().byteDayCount).toBe(IMAGES_JPEG.byteLength);
    expect(usedGlobally(h)).toBe(IMAGES_JPEG.byteLength);
  });

  it("a replay after a full count counts nothing again", async () => {
    const store = new DiesOnceBeforeAnswer();
    const h = harness(serve(HEIC, "image/heic"), store);
    await sendPhoto(h, "image/heic");
    expect(await h.runner.runDueTurn()).toBe("retry");
    h.advance(60_000);
    expect(await h.runner.runDueTurn()).toBe("ran");
    expect(store.meta().byteDayCount).toBe(IMAGES_JPEG.byteLength);
    expect(usedGlobally(h)).toBe(IMAGES_JPEG.byteLength);
  });
});

