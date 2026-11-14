import { describe, expect, it } from "vitest";
import { MAX_SPOKEN_CHARS, SIMBA_MODEL, SIMBA_VOICE, speak } from "../src/speech.js";

const MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]);
const audio = () => Response.json({ audio_data: btoa(String.fromCharCode(...MP3)), audio_format: "mp3" });

describe("speaking a reply with Simba", () => {
  it("asks Simba 3.5 for the reply in Mano's voice as MP3, and returns the bytes", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return audio();
    }) as unknown as typeof fetch;
    expect(await speak(" Your renewal is due by December 3. ", { apiKey: "test-speech-key", fetchFn })).toEqual(MP3);
    expect(calls[0]!.url).toBe("https://api.speechify.ai/v1/audio/speech");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer test-speech-key");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ input: "Your renewal is due by December 3.", voice_id: SIMBA_VOICE, model: SIMBA_MODEL, audio_format: "mp3" });
    expect(SIMBA_MODEL).toBe("simba-3.5");
  });

  it("speaks nothing too long or empty, and calls no one for it", async () => {
    let called = 0;
    const fetchFn = (async () => {
      called += 1;
      return audio();
    }) as unknown as typeof fetch;
    expect(await speak("a".repeat(MAX_SPOKEN_CHARS + 1), { apiKey: "k", fetchFn })).toBeNull();
    expect(await speak("  ", { apiKey: "k", fetchFn })).toBeNull();
    expect(called).toBe(0);
  });

  it.each([
    ["a refusal", new Response("rate limited", { status: 429 })],
    ["no audio", Response.json({ audio_format: "mp3" })],
    ["a body that is not JSON", new Response("<html>", { status: 200 })],
  ])("gives no audio for %s", async (_name, res) => {
    expect(await speak("Hello.", { apiKey: "k", fetchFn: (async () => res) as unknown as typeof fetch })).toBeNull();
  });
});
