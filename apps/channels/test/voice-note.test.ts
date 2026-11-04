import { describe, expect, it } from "vitest";
import { StandInResponder, VOICE_UNHEARD_TEXT, type StoredPhoto, type TurnInput } from "@mano/channels";

import { KNOWN_TYPES, isVoiceNote, sniffMediaType } from "../src/files.js";
import { inboundEvent, makeHarness, runTurnAfterBatch } from "./helpers.js";

const ascii = (text: string) => new TextEncoder().encode(text);
const CAF = ascii("caff\u0000\u0001\u0000\u0000desc synthetic voice note");
const M4A = ascii("\u0000\u0000\u0000\u0020ftypM4A \u0000\u0000\u0000\u0000 synthetic");

// A responder that hears what the test says, and records what it was given.
function hearing(heard: string | null, reply = "Got it, here is what happens next.", missed = heard === null) {
  const turns: TurnInput[] = [];
  const asked: StoredPhoto[][] = [];
  const responder = Object.assign(new StandInResponder([reply]), {
    readsPhotos: true as const,
    async listen(notes: StoredPhoto[]) {
      asked.push(notes);
      return { text: heard ?? "", missed };
    },
  });
  const respond = responder.respond.bind(responder);
  responder.respond = async (turn: TurnInput, hooks) => {
    turns.push(turn);
    return respond(turn, hooks);
  };
  return { responder, turns, asked };
}

const mediaFetch = (bytes: Uint8Array, type: string) =>
  (async (url: string | URL | Request) => {
    if (String(url).includes("security.cloudflare-dns.com")) return Response.json({ Status: 0, Answer: [{ type: 1, data: "1.1.1.1" }] });
    return new Response(bytes as BufferSource, { status: 200, headers: { "content-type": type } });
  }) as unknown as typeof fetch;

async function voiceNote(responder: ReturnType<typeof hearing>["responder"], opts: { text?: string; bytes?: Uint8Array; type?: string } = {}) {
  const bytes = opts.bytes ?? CAF;
  const type = opts.type ?? "audio/x-caf";
  const h = makeHarness({ responder, fetchFn: mediaFetch(bytes, type), config: { mediaHosts: ["cdn.example.test"] } });
  await h.runner.handleEvent(
    inboundEvent({ id: "evt_voice", occurredAtMs: h.now, text: opts.text ?? "", attachments: [{ url: "https://cdn.example.test/Audio%20Message.caf", mediaType: type, size: bytes.byteLength }] }),
    "webhook",
  );
  await runTurnAfterBatch(h);
  return { h, sends: h.channel.sends.map((s) => s.text) };
}

describe("what kind of file came", () => {
  it.each([
    ["an iMessage .caf", CAF, "audio/x-caf"],
    ["an m4a", M4A, "audio/mp4"],
    ["a WAV", ascii("RIFF\u0024\u0000\u0000\u0000WAVEfmt "), "audio/wav"],
    ["an Ogg", ascii("OggS\u0000 synthetic"), "audio/ogg"],
    ["an mp3", ascii("ID3\u0004 synthetic"), "audio/mpeg"],
  ])("%s is read from its bytes", (_name, bytes, type) => {
    expect(sniffMediaType(bytes)).toBe(type);
    expect(KNOWN_TYPES.has(type)).toBe(true);
    expect(isVoiceNote(type)).toBe(true);
  });

  it("a photo or a video is not a voice note", () => {
    for (const type of ["image/jpeg", "video/mp4", "application/octet-stream"]) expect(isVoiceNote(type)).toBe(false);
  });
});

describe("a voice note on the text line", () => {
  it("goes to the agent as the person's words, marked as heard, and never as a photo", async () => {
    const { responder, turns, asked } = hearing("se me acaban los beneficios");
    const { h, sends } = await voiceNote(responder);
    expect(asked[0]).toEqual([expect.objectContaining({ mimeType: "audio/x-caf" })]);
    expect(turns[0]).toMatchObject({ texts: ["se me acaban los beneficios"], attachmentCount: 0, documents: [], spoken: true, crisis: false });
    expect(sends.join("\n")).toContain("Got it");
    expect(h.channel.sends.length).toBeGreaterThan(0);
  });

  it("joins the words typed with it", async () => {
    const { responder, turns } = hearing("my renewal is due friday");
    await voiceNote(responder, { text: "listen to this" });
    expect(turns[0]!.texts).toEqual(["listen to this\nmy renewal is due friday"]);
  });

  it.each(["I want to kill myself", "quiero matarme"])("%j reaches the crisis floor, and the line goes first", async (said) => {
    const { responder, turns } = hearing(said);
    const { sends } = await voiceNote(responder);
    expect(turns[0]).toMatchObject({ crisis: true });
    expect(sends[0]).toMatch(/988/);
    expect(sends.filter((s) => s === sends[0])).toHaveLength(1);
  });

  it("checks every word for a crisis, even past what the agent reads", async () => {
    const said = `${"My appointment is on Friday. ".repeat(160)}I want to kill myself`;
    const { responder, turns } = hearing(said);
    const { sends } = await voiceNote(responder);
    expect(sends[0]).toMatch(/988/);
    expect(turns[0]).toMatchObject({ crisis: true });
    expect(turns[0]!.texts[0]!.length).toBeLessThanOrEqual(4000);
    expect(turns[0]!.texts[0]).not.toContain("kill myself");
  });

  it("with one of two notes unheard, answers what it heard and says so", async () => {
    const { responder, turns } = hearing("my renewal is due friday", undefined, true);
    const { sends } = await voiceNote(responder);
    expect(turns[0]!.texts).toEqual(["my renewal is due friday"]);
    expect(sends.join("\n")).toContain("Got it");
    expect(sends.at(-1)).toBe(VOICE_UNHEARD_TEXT);
  });

  it("says plainly it could not listen when nothing could, without the model", async () => {
    const { responder, turns } = hearing(null);
    const { sends } = await voiceNote(responder);
    expect(turns).toHaveLength(0);
    expect(sends.join("\n")).toContain(VOICE_UNHEARD_TEXT);
    expect(sends.join("\n")).not.toMatch(/photo/i);
  });

  it("answers the words typed with it, and still says it could not listen", async () => {
    const { responder, turns } = hearing(null);
    const { sends } = await voiceNote(responder, { text: "what about this" });
    expect(turns[0]).toMatchObject({ texts: ["what about this"], attachmentCount: 0 });
    expect(turns[0]!.spoken).toBeUndefined();
    expect(sends.join("\n")).toContain("Got it");
    expect(sends.join("\n")).toContain(VOICE_UNHEARD_TEXT);
  });

  it("a responder that cannot listen says the same", async () => {
    const responder = new StandInResponder(["unused"]);
    const { sends } = await voiceNote(responder as never);
    expect(sends.join("\n")).toContain(VOICE_UNHEARD_TEXT);
  });

  it("a photo still reads as a photo", async () => {
    const { responder, asked, turns } = hearing("unused");
    await voiceNote(responder, { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), type: "image/jpeg" });
    expect(asked).toHaveLength(0);
    expect(turns[0]).toMatchObject({ attachmentCount: 1 });
    expect(turns[0]!.documents).toHaveLength(1);
  });
});
