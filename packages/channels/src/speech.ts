// Mano's reply as a voice note, spoken by Simba 3.5 on the Speechify API.
// Only Mano's own words go, after the same words went out as text. Any
// failure is no audio, never an error. Never logs the words.
import { boundFetch } from "./fetch.js";

export const SIMBA_MODEL = "simba-3.5";
// Chosen on November 14, 2026 (docs/decisions.md): heard word for word in
// English and Spanish when transcribed back, and among the best rated.
export const SIMBA_VOICE = "kara";
// A longer reply stays text only: a voice note is for a short answer.
export const MAX_SPOKEN_CHARS = 800;
const SPEECH_URL = "https://api.speechify.ai/v1/audio/speech";
const SPEAK_TIMEOUT_MS = 15_000;

// The reply as MP3 bytes, or null when it is too long or nothing came back.
export async function speak(text: string, opts: { apiKey: string; fetchFn?: typeof fetch }): Promise<Uint8Array | null> {
  const input = text.trim();
  if (!input || input.length > MAX_SPOKEN_CHARS) return null;
  const res = await (opts.fetchFn ?? boundFetch)(SPEECH_URL, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(SPEAK_TIMEOUT_MS),
    headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ input, voice_id: SIMBA_VOICE, model: SIMBA_MODEL, audio_format: "mp3" }),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  const data = (await res.json().catch(() => null)) as { audio_data?: unknown } | null;
  if (typeof data?.audio_data !== "string" || data.audio_data === "") return null;
  return Uint8Array.from(atob(data.audio_data), (c) => c.charCodeAt(0));
}
