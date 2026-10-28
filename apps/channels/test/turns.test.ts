import { describe, expect, it } from "vitest";
import { HANDLE_BYTES_DAILY, ResponderFailed, decryptForPerson, documentAad } from "@mano/channels";
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
        maxAttempts: 1,
        respond: async () => {
          const text = await gate;
          return { text, bubbles: [text], inputChars: 10, outputChars: text.length, model: "stand-in", attempts: 1 };
        },
      },
    });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Think hard.", occurredAtMs: h.now }), "webhook");
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
        maxAttempts: 1,
        respond: async () => {
          throw new Error("model down");
        },
      },
    });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Hello.", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    expect(h.channel.sends.map((s) => s.text)).toContain(FAILURE_BUBBLE);
    expect(h.channel.typingCalls[h.channel.typingCalls.length - 1].state).toBe("stopped");
  });

  it("settles failed attempts against the reservation", async () => {
    const h = makeHarness({
      config: { usdPer1kChars: 0.01 },
      responder: {
        name: "flaky",
        maxAttempts: 3,
        respond: async () => {
          throw new ResponderFailed("model down", 3, 1000);
        },
      },
    });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Hello.", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    expect(h.channel.sends.map((s) => s.text)).toContain(FAILURE_BUBBLE);
    expect(h.ledger.spent().spentUsd).toBeCloseTo(0.03);
  });
});

describe("attachments", () => {
  const PHOTO = new TextEncoder().encode("synthetic-photo-bytes");
  const CLEAN_DOH = JSON.stringify({ Status: 0, Answer: [{ name: "cdn.example.test.", type: 1, data: "203.0.113.7" }] });

  function photoFetch(): typeof fetch {
    return (async (url: unknown) => {
      if (String(url).includes("dns-query")) {
        return new Response(CLEAN_DOH, { status: 200, headers: { "content-type": "application/dns-json" } });
      }
      return new Response(PHOTO, { status: 200, headers: { "content-type": "image/jpeg" } });
    }) as typeof fetch;
  }

  const MEDIA = { mediaHosts: ["cdn.example.test"] };

  it("saves photos encrypted and acknowledges in one line", async () => {
    const h = makeHarness({
      fetchFn: photoFetch(),
      replies: ["About your bill."],
      config: MEDIA,
    });
    await h.runner.handleEvent(
      inboundEvent({
        id: "evt_photo",
        occurredAtMs: h.now,
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
    const h = makeHarness({ fetchFn: photoFetch(), config: MEDIA });
    await h.runner.handleEvent(
      inboundEvent({
        id: "evt_big",
        occurredAtMs: h.now,
        text: null,
        attachments: [{ url: "https://cdn.example.test/big.mov", mediaType: "video/mp4", size: 50_000_000 }],
      }),
      "webhook",
    );
    await runTurnAfterBatch(h);
    expect(h.files.files.size).toBe(0);
    expect(h.channel.sends.some((s) => s.text.startsWith("Got your"))).toBe(false);
  });

  it("downloads nothing when admission fails", async () => {
    let downloads = 0;
    const h = makeHarness({
      budgetUsd: 0.000001,
      fetchFn: (async () => {
        downloads += 1;
        return new Response(PHOTO, { status: 200 });
      }) as typeof fetch,
    });
    await h.runner.handleEvent(
      inboundEvent({
        id: "evt_busy_photo",
        occurredAtMs: h.now,
        text: "Look.",
        attachments: [{ url: "https://cdn.example.test/p1.jpg", mediaType: "image/jpeg", size: 21 }],
      }),
      "webhook",
    );
    await runTurnAfterBatch(h);
    expect(downloads).toBe(0);
    expect(h.files.files.size).toBe(0);
    expect(h.channel.sends[0].text).toContain("busy");
  });

  it("enforces the per-handle daily byte budget", async () => {
    const h = makeHarness({ fetchFn: photoFetch(), config: MEDIA });
    const meta = h.store.meta();
    meta.byteDayKey = new Date(h.now).toISOString().slice(0, 10);
    meta.byteDayCount = HANDLE_BYTES_DAILY - 1;
    h.store.saveMeta(meta);
    await h.runner.handleEvent(
      inboundEvent({
        id: "evt_capped",
        occurredAtMs: h.now,
        text: "Photo.",
        attachments: [{ url: "https://cdn.example.test/p1.jpg", mediaType: "image/jpeg", size: 21 }],
      }),
      "webhook",
    );
    await runTurnAfterBatch(h);
    expect(h.files.files.size).toBe(0);
    expect(h.lines.join("\n")).toContain("attachment_capped");
    h.advance(24 * 3600 * 1000 + 1000);
    await h.runner.handleEvent(
      inboundEvent({
        id: "evt_next_day",
        occurredAtMs: h.now,
        text: "Photo.",
        attachments: [{ url: "https://cdn.example.test/p2.jpg", mediaType: "image/jpeg", size: 21 }],
      }),
      "webhook",
    );
    await runTurnAfterBatch(h);
    expect(h.files.files.size).toBe(1);
  });

  it("releases the budget hold on a photo-only turn", async () => {
    const h = makeHarness({ fetchFn: photoFetch(), config: MEDIA });
    await h.runner.handleEvent(
      inboundEvent({
        id: "evt_photo_only",
        text: null,
        occurredAtMs: h.now,
        attachments: [{ url: "https://cdn.example.test/p1.jpg", mediaType: "image/jpeg", size: 21 }],
      }),
      "webhook",
    );
    await runTurnAfterBatch(h);
    expect(h.files.files.size).toBe(1);
    expect(h.ledger.spent().spentUsd).toBe(0);
    expect(h.ledger.reserve("probe:1", 5).allowed).toBe(true);
  });

  it("holds files when the global byte budget is spent", async () => {
    const h = makeHarness({ fetchFn: photoFetch(), byteBudget: 1, config: MEDIA });
    await h.runner.handleEvent(
      inboundEvent({
        id: "evt_gbytes",
        occurredAtMs: h.now,
        text: "Photo.",
        attachments: [{ url: "https://cdn.example.test/p1.jpg", mediaType: "image/jpeg", size: 21 }],
      }),
      "webhook",
    );
    await runTurnAfterBatch(h);
    expect(h.files.files.size).toBe(0);
    expect(h.channel.sends.some((s) => s.text.startsWith("Got your"))).toBe(false);
  });
});

describe("link safety", () => {
  function dohFetch(fetched: string[]): typeof fetch {
    return (async (url: unknown) => {
      fetched.push(String(url));
      const raw = String(url);
      if (raw.includes("name=evil.test")) {
        return new Response(JSON.stringify({ Status: 0, Answer: [{ data: "0.0.0.0" }] }), { status: 200 });
      }
      if (raw.includes("dns-query")) {
        return new Response(JSON.stringify({ Status: 0, Answer: [{ data: "203.0.113.7" }] }), { status: 200 });
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
  }

  it("removes blocked links from replies instead of sending them", async () => {
    const fetched: string[] = [];
    const h = makeHarness({
      fetchFn: dohFetch(fetched),
      replies: ["Read https://ok.test/guide and https://evil.test/trap for details."],
    });
    await h.runner.handleEvent(inboundEvent({ id: "evt_link", text: "Links?", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    const answer = h.channel.sends.find((s) => s.text.includes("Read "))!;
    expect(answer.text).toContain("https://ok.test/guide");
    expect(answer.text).not.toContain("https://evil.test/trap");
    expect(answer.text).toContain("(link removed)");
    expect(fetched.some((u) => u.startsWith("https://family.cloudflare-dns.com/dns-query"))).toBe(true);
    expect(h.lines.join("\n")).not.toContain("evil.test");
  });

  it("strips uppercase and bare links from replies", async () => {
    const fetched: string[] = [];
    const h = makeHarness({
      fetchFn: dohFetch(fetched),
      replies: ["Open HTTPS://EVIL.TEST/trap or evil.test/again for more."],
    });
    await h.runner.handleEvent(inboundEvent({ id: "evt_caps", text: "Links?", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    const answer = h.channel.sends.find((s) => s.text.includes("Open "))!;
    expect(answer.text).not.toContain("EVIL.TEST");
    expect(answer.text).not.toContain("evil.test");
    expect(answer.text.match(/\(link removed\)/g)).toHaveLength(2);
    expect(fetched.filter((u) => u.includes("name=evil.test"))).not.toHaveLength(0);
  });

  it("refuses attachments off the provider media hosts without fetching", async () => {
    const fetched: string[] = [];
    const h = makeHarness({ fetchFn: dohFetch(fetched), config: { mediaHosts: ["cdn.example.test"] } });
    await h.runner.handleEvent(
      inboundEvent({
        id: "evt_evil_file",
        occurredAtMs: h.now,
        text: "File.",
        attachments: [{ url: "https://evil.test/payload.bin", mediaType: "application/octet-stream", size: 10 }],
      }),
      "webhook",
    );
    await runTurnAfterBatch(h);
    expect(h.files.files.size).toBe(0);
    expect(fetched).toHaveLength(0);
  });

  it("keeps every bubble under the cap after links come out", async () => {
    const fetched: string[] = [];
    const blockAll = (async (url: unknown) => {
      fetched.push(String(url));
      return new Response(JSON.stringify({ Status: 0, Answer: [{ data: "0.0.0.0" }] }), { status: 200 });
    }) as typeof fetch;
    // One long sentence: short bare links that each grow when replaced,
    // so splitting first would overflow the bubble.
    const links = Array.from({ length: 10 }, (_, i) => `qx${i}.aa`).join(" ");
    const reply = `${"word ".repeat(100)}${links} end.`;
    const h = makeHarness({ fetchFn: blockAll, replies: [reply] });
    await h.runner.handleEvent(inboundEvent({ id: "evt_cap", text: "Long?", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    expect(h.channel.sends.length).toBeGreaterThan(1);
    for (const send of h.channel.sends) {
      expect(send.text.length).toBeLessThanOrEqual(600);
    }
    const joined = h.channel.sends.map((s) => s.text).join(" ");
    expect(joined).toContain("(link removed)");
    expect(joined).not.toContain("qx0.aa");
  });

  it("replays persisted bubbles without checking links again", async () => {
    const fetched: string[] = [];
    const h = makeHarness({
      fetchFn: dohFetch(fetched),
      replies: ["Read https://ok.test/guide and https://evil.test/trap."],
    });
    await h.runner.handleEvent(inboundEvent({ id: "evt_replay", text: "Links?", occurredAtMs: h.now }), "webhook");
    h.advance(h.batchMs + 100);
    const realUpdate = h.store.updateOutbound.bind(h.store);
    let fails = 1;
    h.store.updateOutbound = ((...args: Parameters<typeof realUpdate>) => {
      if (fails > 0) {
        fails -= 1;
        throw new Error("storage down");
      }
      return realUpdate(...args);
    }) as typeof realUpdate;
    expect(await h.runner.runDueTurn()).toBe("retry");
    h.store.updateOutbound = realUpdate;
    const dohBefore = fetched.filter((u) => u.includes("dns-query")).length;
    expect(dohBefore).toBeGreaterThan(0);
    expect(await h.runner.runDueTurn()).toBe("ran");
    expect(fetched.filter((u) => u.includes("dns-query"))).toHaveLength(dohBefore);
    const answer = h.channel.sends.find((s) => s.text.includes("Read "))!;
    expect(answer.text).toContain("https://ok.test/guide");
    expect(answer.text).not.toContain("evil.test");
  });

  it("never splits a link across bubbles with the tail unchecked", async () => {
    const fetched: string[] = [];
    const selective = (async (url: unknown) => {
      fetched.push(String(url));
      const clean = String(url).includes("name=xevil.test");
      return new Response(JSON.stringify({ Status: 0, Answer: [{ data: clean ? "203.0.113.7" : "0.0.0.0" }] }), {
        status: 200,
      });
    }) as typeof fetch;
    // One sentence with xevil.test/trap straddling the old 600-char cut:
    // a character split would leave an unchecked l.test/trap behind.
    const reply = `${"w ".repeat(298)}xevil.test/trap end of message.`;
    const h = makeHarness({ fetchFn: selective, replies: [reply] });
    await h.runner.handleEvent(inboundEvent({ id: "evt_straddle", text: "Long?", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    const answers = h.channel.sends.filter((s) => !s.text.includes("automated assistant"));
    expect(answers.some((s) => s.text.includes("xevil.test/trap"))).toBe(true);
    for (const send of answers) {
      if (send.text.includes("trap")) expect(send.text).toContain("xevil.test/trap");
    }
    expect(fetched.some((u) => u.includes("name=xevil.test"))).toBe(true);
    expect(fetched.some((u) => u.includes("name=l.test"))).toBe(false);
  });

  it("checks every redirect hop before following it", async () => {
    const fetched: string[] = [];
    const h = makeHarness({
      config: { mediaHosts: ["cdn.example.test"] },
      fetchFn: (async (url: unknown) => {
        fetched.push(String(url));
        const raw = String(url);
        if (raw.includes("dns-query")) {
          const blocked = raw.includes("name=evil.test");
          return new Response(
            JSON.stringify({ Status: 0, Answer: [{ data: blocked ? "0.0.0.0" : "203.0.113.7" }] }),
            { status: 200 },
          );
        }
        if (raw === "https://cdn.example.test/hop") {
          return new Response("", { status: 302, headers: { location: "https://evil.test/payload.bin" } });
        }
        return new Response("photo", { status: 200 });
      }) as typeof fetch,
    });
    await h.runner.handleEvent(
      inboundEvent({
        id: "evt_hop",
        occurredAtMs: h.now,
        text: "File.",
        attachments: [{ url: "https://cdn.example.test/hop", mediaType: "image/jpeg", size: 5 }],
      }),
      "webhook",
    );
    await runTurnAfterBatch(h);
    expect(h.files.files.size).toBe(0);
    expect(fetched).not.toContain("https://evil.test/payload.bin");
  });
});

describe("approvals by text", () => {
  it("accepts YES and NO only for a matching code", async () => {
    const h = makeHarness();
    await h.runner.requestApproval({ id: "apr_1", code: "K7Q2", summary: "File the renewal.", ttlMs: 600_000 });
    await h.runner.handleEvent(inboundEvent({ id: "evt_yes", text: "YES K7Q2", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    expect(h.store.pendingApprovals(h.now)).toHaveLength(0);
    expect(h.channel.sends.map((s) => s.text)).toContain("Recorded. I will follow up when it is decided.");
    expect((h.responder as unknown as { prompts: unknown[] }).prompts).toHaveLength(0);

    await h.runner.requestApproval({ id: "apr_2", code: "M3P9", summary: "Share the pay stub.", ttlMs: 600_000 });
    await h.runner.handleEvent(inboundEvent({ id: "evt_no", text: "NO M3P9", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    expect(h.store.pendingApprovals(h.now)).toHaveLength(0);
  });

  it("treats a wrong code as a normal message", async () => {
    const h = makeHarness();
    await h.runner.requestApproval({ id: "apr_1", code: "K7Q2", summary: "File the renewal.", ttlMs: 600_000 });
    await h.runner.handleEvent(inboundEvent({ id: "evt_wrong", text: "YES ZZZZ", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    expect(h.store.pendingApprovals(h.now)).toHaveLength(1);
    expect((h.responder as unknown as { prompts: unknown[] }).prompts).toHaveLength(1);
  });

  it("lets codes expire", async () => {
    const h = makeHarness();
    await h.runner.requestApproval({ id: "apr_1", code: "K7Q2", summary: "File the renewal.", ttlMs: 1000 });
    h.advance(2000);
    await h.runner.handleEvent(inboundEvent({ id: "evt_late", text: "YES K7Q2", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    expect((h.responder as unknown as { prompts: unknown[] }).prompts).toHaveLength(1);
  });
});
