import { describe, expect, it } from "vitest";
import { decryptForPerson, documentAad } from "@mano/channels";
import { FAILURE_BUBBLE, INTERIM_BUBBLE } from "../src/text.js";
import {
  TEST_HANDLE_HASH,
  TEST_KEK_B64,
  inboundEvent,
  makeHarness,
  runTurnAfterBatch,
} from "./helpers.js";

describe("slow answers", () => {
  it("sends one working note, then the answer", async () => {
    let release!: (text: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const h = makeHarness({
      config: { interimMs: 20 },
      responder: {
        name: "slow",
        respond: async () => {
          const text = await gate;
          return { bubbles: [text], inputChars: 10, outputChars: text.length, model: "stand-in" };
        },
      },
    });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Think hard." }), "webhook");
    h.advance(3000);
    const turn = h.runner.runDueTurn();
    await new Promise((r) => setTimeout(r, 60));
    expect(h.channel.sends.filter((s) => s.text === INTERIM_BUBBLE)).toHaveLength(1);
    release("The answer.");
    expect(await turn).toBe("ran");
    expect(h.channel.sends[h.channel.sends.length - 1].text).toBe("The answer.");
    expect(h.channel.typingCalls[h.channel.typingCalls.length - 1].state).toBe("stopped");
  });

  it("says plainly when the answer fails", async () => {
    const h = makeHarness({
      responder: {
        name: "broken",
        respond: async () => {
          throw new Error("model down");
        },
      },
    });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Hello." }), "webhook");
    await runTurnAfterBatch(h);
    expect(h.channel.sends.map((s) => s.text)).toContain(FAILURE_BUBBLE);
    expect(h.channel.typingCalls[h.channel.typingCalls.length - 1].state).toBe("stopped");
  });
});

describe("attachments", () => {
  const PHOTO = new TextEncoder().encode("synthetic-photo-bytes");

  function photoFetch(): typeof fetch {
    return (async () => new Response(PHOTO, { status: 200, headers: { "content-type": "image/jpeg" } })) as typeof fetch;
  }

  it("saves photos encrypted and acknowledges in one line", async () => {
    const h = makeHarness({
      fetchFn: photoFetch(),
      replies: ["About your bill."],
    });
    await h.runner.handleEvent(
      inboundEvent({
        id: "evt_photo",
        text: "What is this?",
        attachments: [{ url: "https://cdn.example.test/p1.jpg", mediaType: "image/jpeg", size: 21 }],
      }),
      "webhook",
    );
    await runTurnAfterBatch(h);
    expect(h.files.files.size).toBe(1);
    const [key, stored] = [...h.files.files.entries()][0];
    expect(key.startsWith(`persons/${TEST_HANDLE_HASH}/docs/t1i0-`)).toBe(true);
    const blob = JSON.parse(new TextDecoder().decode(stored)) as Parameters<typeof decryptForPerson>[0];
    const back = await decryptForPerson(blob, TEST_KEK_B64, documentAad(TEST_HANDLE_HASH, key.split("/").pop()!));
    expect(new TextDecoder().decode(back)).toBe("synthetic-photo-bytes");
    const ack = h.channel.sends.find((s) => s.text.startsWith("Got your"))!;
    expect(ack.text).toBe("Got your photo. I will read it and follow up.");
    expect(ack.text).not.toContain("\n");
  });

  it("skips files over the size cap", async () => {
    const h = makeHarness({ fetchFn: photoFetch() });
    await h.runner.handleEvent(
      inboundEvent({
        id: "evt_big",
        text: null,
        attachments: [{ url: "https://cdn.example.test/big.mov", mediaType: "video/mp4", size: 50_000_000 }],
      }),
      "webhook",
    );
    await runTurnAfterBatch(h);
    expect(h.files.files.size).toBe(0);
    expect(h.channel.sends.some((s) => s.text.startsWith("Got your"))).toBe(false);
  });
});

describe("approvals by text", () => {
  it("accepts YES and NO only for a matching code", async () => {
    const h = makeHarness();
    await h.runner.requestApproval({ id: "apr_1", code: "K7Q2", summary: "File the renewal.", ttlMs: 600_000 });
    await h.runner.handleEvent(inboundEvent({ id: "evt_yes", text: "YES K7Q2" }), "webhook");
    await runTurnAfterBatch(h);
    expect(h.store.pendingApprovals(h.now)).toHaveLength(0);
    expect(h.channel.sends.map((s) => s.text)).toContain("Recorded. I will follow up when it is decided.");
    expect((h.responder as unknown as { prompts: unknown[] }).prompts).toHaveLength(0);

    await h.runner.requestApproval({ id: "apr_2", code: "M3P9", summary: "Share the pay stub.", ttlMs: 600_000 });
    await h.runner.handleEvent(inboundEvent({ id: "evt_no", text: "NO M3P9" }), "webhook");
    await runTurnAfterBatch(h);
    expect(h.store.pendingApprovals(h.now)).toHaveLength(0);
  });

  it("treats a wrong code as a normal message", async () => {
    const h = makeHarness();
    await h.runner.requestApproval({ id: "apr_1", code: "K7Q2", summary: "File the renewal.", ttlMs: 600_000 });
    await h.runner.handleEvent(inboundEvent({ id: "evt_wrong", text: "YES ZZZZ" }), "webhook");
    await runTurnAfterBatch(h);
    expect(h.store.pendingApprovals(h.now)).toHaveLength(1);
    expect((h.responder as unknown as { prompts: unknown[] }).prompts).toHaveLength(1);
  });

  it("lets codes expire", async () => {
    const h = makeHarness();
    await h.runner.requestApproval({ id: "apr_1", code: "K7Q2", summary: "File the renewal.", ttlMs: 1000 });
    h.advance(2000);
    await h.runner.handleEvent(inboundEvent({ id: "evt_late", text: "YES K7Q2" }), "webhook");
    await runTurnAfterBatch(h);
    expect((h.responder as unknown as { prompts: unknown[] }).prompts).toHaveLength(1);
  });
});
