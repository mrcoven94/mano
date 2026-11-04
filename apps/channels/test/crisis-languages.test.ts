import { describe, expect, it } from "vitest";
import { StandInResponder, type TurnInput } from "@mano/channels";

import { inboundEvent, makeHarness, runTurnAfterBatch } from "./helpers.js";

// A photo sent with words in Vietnamese or Tagalog, whatever happens to the
// reading after it. The reply here is what the agent sends when reading used
// up the budget for the model: the letter's answer alone, with no crisis
// words of its own. The crisis line has to come from Channels.
const LETTER_ONLY = "This is a SNAP renewal letter. It is due November 20, 2026.";
const CLEAN_DOH = JSON.stringify({ Status: 0, Answer: [{ name: "cdn.example.test.", type: 1, data: "203.0.113.7" }] });
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const fetchFn = (async (url: unknown) =>
  String(url).includes("dns-query")
    ? new Response(CLEAN_DOH, { status: 200, headers: { "content-type": "application/dns-json" } })
    : new Response(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } })) as typeof fetch;

async function photoWith(text: string, responder: StandInResponder) {
  const h = makeHarness({ responder, fetchFn, config: { mediaHosts: ["cdn.example.test"] } });
  await h.runner.handleEvent(
    inboundEvent({ id: "evt_crisis_photo", occurredAtMs: h.now, text, attachments: [{ url: "https://cdn.example.test/letter.jpg", mediaType: "image/jpeg" }] }),
    "webhook",
  );
  await runTurnAfterBatch(h);
  return h.channel.sends.map((s) => s.text);
}

function reader() {
  const turns: TurnInput[] = [];
  const responder = Object.assign(new StandInResponder([LETTER_ONLY]), { readsPhotos: true as const });
  const respond = responder.respond.bind(responder);
  responder.respond = async (turn, hooks) => {
    turns.push(turn);
    return respond(turn, hooks);
  };
  return { responder, turns };
}

describe("a crisis written beside a photo", () => {
  it.each(["Papatayin ko ang sarili ko", "Chồng tôi đang đánh tôi", "Tôi đang gặp nguy hiểm", "binubugbog ako ng asawa ko", "nasa panganib ako"])(
    "%j gets 988 and 911 first, then the letter, when the reading used up the model's budget",
    async (text) => {
      const { responder, turns } = reader();
      const sends = await photoWith(text, responder);
      expect(sends[0]).toMatch(/988/);
      expect(sends[0]).toMatch(/911/);
      expect(sends.filter((s) => s === sends[0])).toHaveLength(1);
      expect(sends.join("\n")).toContain("SNAP renewal letter");
      // The decision reaches the agent, so it never asks about the document instead.
      expect(turns[0]).toMatchObject({ crisis: true });
    },
  );

  it("gets the line even when nothing answers at all", async () => {
    const responder = Object.assign(new StandInResponder(["unused"]), { readsPhotos: true as const });
    responder.respond = async () => {
      throw new Error("down");
    };
    expect((await photoWith("Tôi đang gặp nguy hiểm", responder))[0]).toMatch(/988/);
  });

  it("an ordinary line beside a photo gets no crisis line", async () => {
    const { responder, turns } = reader();
    const sends = await photoWith("Thư này nói gì vậy", responder);
    expect(sends.join("\n")).not.toMatch(/988/);
    expect(turns[0]).toMatchObject({ crisis: false });
  });
});
