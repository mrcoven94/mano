import { describe, expect, it } from "vitest";
import { StandInResponder, type StoredPhoto, type TurnInput } from "@mano/channels";

import type { VoiceReplies } from "../src/runner.js";
import { VOICE_TTL_MS, serveVoice, sweepVoice } from "../src/voice.js";
import { inboundEvent, makeHarness, runTurnAfterBatch } from "./helpers.js";

const CAF = new TextEncoder().encode("caff\u0000\u0001\u0000\u0000desc synthetic voice note");
const VOICE_URL = "https://text.withmano.com/voice/0123456789abcdef0123456789abcdef.mp3";

function hearing(heard: string, reply = "Your renewal is due by December 3. I can fill it out with you now.") {
  const turns: TurnInput[] = [];
  const responder = Object.assign(new StandInResponder([reply]), {
    readsPhotos: true as const,
    async listen(_notes: StoredPhoto[]) {
      return { text: heard, missed: false };
    },
  });
  return { responder, turns };
}

function recorder(url: string | null = VOICE_URL) {
  const spoken: string[] = [];
  const voice: VoiceReplies = {
    async record(text: string) {
      spoken.push(text);
      return url;
    },
  };
  return { voice, spoken };
}

const mediaFetch = (async (url: string | URL | Request) => {
  if (String(url).includes("security.cloudflare-dns.com")) return Response.json({ Status: 0, Answer: [{ type: 1, data: "1.1.1.1" }] });
  return new Response(CAF as BufferSource, { status: 200, headers: { "content-type": "audio/x-caf" } });
}) as unknown as typeof fetch;

async function turn(opts: { heard: string; voice: VoiceReplies | null; withNote?: boolean; text?: string }) {
  const { responder } = hearing(opts.heard);
  const h = makeHarness({ responder, fetchFn: mediaFetch, voice: opts.voice, config: { mediaHosts: ["cdn.example.test"] } });
  const attachments = opts.withNote === false ? [] : [{ url: "https://cdn.example.test/Audio%20Message.caf", mediaType: "audio/x-caf", size: CAF.byteLength }];
  await h.runner.handleEvent(inboundEvent({ id: "evt_voice", occurredAtMs: h.now, text: opts.text ?? "", attachments }), "webhook");
  await runTurnAfterBatch(h);
  await h.decorations.idle();
  return h;
}

describe("a reply to a voice note, spoken", () => {
  it("goes as a voice note after the words, with the reply's words and no text of its own", async () => {
    const { voice, spoken } = recorder();
    const h = await turn({ heard: "my food benefits letter came", voice });
    const sends = h.channel.sends;
    const voiceAt = sends.findIndex((s) => s.attachment);
    expect(voiceAt).toBeGreaterThan(0);
    expect(sends[voiceAt]).toMatchObject({ attachment: VOICE_URL, text: "", once: true });
    expect(sends.slice(0, voiceAt).map((s) => s.text).join("\n")).toContain("December 3");
    expect(spoken).toEqual([expect.stringContaining("Your renewal is due by December 3.")]);
    expect(h.store.outbounds().filter((r) => r.tag === "voice")).toEqual([expect.objectContaining({ state: "sent", text: "" })]);
  });

  it("is not spoken for a typed message, with the switch off, or on a crisis turn", async () => {
    const typed = recorder();
    const h1 = await turn({ heard: "", voice: typed.voice, withNote: false, text: "when is my renewal due" });
    expect(h1.channel.sends.some((s) => s.attachment)).toBe(false);
    expect(typed.spoken).toEqual([]);

    const off = await turn({ heard: "my food benefits letter came", voice: null });
    expect(off.channel.sends.some((s) => s.attachment)).toBe(false);

    const crisis = recorder();
    const h3 = await turn({ heard: "I want to kill myself", voice: crisis.voice });
    expect(h3.channel.sends[0]!.text).toMatch(/988/);
    expect(h3.channel.sends.some((s) => s.attachment)).toBe(false);
    expect(crisis.spoken).toEqual([]);
  });

  it("when it cannot be spoken, the words stand alone and nothing is tried again", async () => {
    const { voice, spoken } = recorder(null);
    const h = await turn({ heard: "my food benefits letter came", voice });
    expect(spoken).toHaveLength(1);
    expect(h.channel.sends.some((s) => s.attachment)).toBe(false);
    expect(h.channel.sends.map((s) => s.text).join("\n")).toContain("December 3");
    expect(h.store.outbounds().filter((r) => r.tag === "voice")).toEqual([expect.objectContaining({ state: "refused", code: "unspoken" })]);
  });
});

describe("the spoken reply's file", () => {
  const ID = "0123456789abcdef0123456789abcdef";
  const uploadedMs = 1_800_000_000_000;
  const bucket = {
    async get(key: string) {
      return key === `voice/${ID}.mp3` ? { uploaded: new Date(uploadedMs), body: new Uint8Array([1, 2, 3]) } : null;
    },
  } as unknown as R2Bucket;

  it("is served briefly to whoever has its unguessable link, never cached", async () => {
    const res = await serveVoice(`/voice/${ID}.mp3`, bucket, uploadedMs + 60_000);
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-type")).toBe("audio/mpeg");
    expect(res!.headers.get("cache-control")).toBe("no-store");
  });

  it("is gone once expired, and nothing else under /voice/ is served", async () => {
    expect((await serveVoice(`/voice/${ID}.mp3`, bucket, uploadedMs + VOICE_TTL_MS + 1))!.status).toBe(404);
    expect((await serveVoice(`/voice/${"f".repeat(32)}.mp3`, bucket, uploadedMs))!.status).toBe(404);
    expect(await serveVoice("/voice/../persons/x.mp3", bucket, uploadedMs)).toBeNull();
    expect(await serveVoice(`/voice/${ID}.wav`, bucket, uploadedMs)).toBeNull();
  });

  it("is swept from the bucket once expired", async () => {
    const asked: [string, number][] = [];
    const deleted: string[][] = [];
    const files = {
      async put() {},
      async deletePrefix() {
        return 0;
      },
      async listOlderThan(prefix: string, beforeMs: number) {
        asked.push([prefix, beforeMs]);
        return [`voice/${ID}.mp3`];
      },
      async deleteKeys(keys: string[]) {
        deleted.push(keys);
        return keys.length;
      },
    };
    expect(await sweepVoice(files, uploadedMs)).toBe(1);
    expect(asked).toEqual([["voice/", uploadedMs - VOICE_TTL_MS]]);
    expect(deleted).toEqual([[`voice/${ID}.mp3`]]);
  });
});
