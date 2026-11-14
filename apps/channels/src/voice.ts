// Voice notes Mano sends back. The audio is kept in Channels' bucket under
// an unguessable name for VOICE_TTL_MS, long enough for the provider to
// fetch it once, then served no more and swept.
import { speak } from "@mano/channels";

import type { Env } from "./env.js";
import type { FileStore } from "./files.js";
import type { VoiceReplies } from "./runner.js";

const PREFIX = "voice/";
// The route Channels serves on (wrangler.toml).
const BASE_URL = "https://text.withmano.com";
export const VOICE_TTL_MS = 15 * 60_000;
const VOICE_PATH = /^\/voice\/([0-9a-f]{32})\.mp3$/;

// On only with MANO_VOICE_REPLIES "on" and a Speechify key.
export function voiceReplies(env: Env): VoiceReplies | null {
  if (env.MANO_VOICE_REPLIES !== "on" || !env.SPEECHIFY_API_KEY) return null;
  const apiKey = env.SPEECHIFY_API_KEY;
  return {
    async record(text: string): Promise<string | null> {
      const audio = await speak(text, { apiKey });
      if (!audio) return null;
      const id = crypto.randomUUID().replaceAll("-", "");
      await env.FILES.put(`${PREFIX}${id}.mp3`, audio as BufferSource, { httpMetadata: { contentType: "audio/mpeg" } });
      return `${BASE_URL}/voice/${id}.mp3`;
    },
  };
}

// GET /voice/<id>.mp3, or null when the path is not one.
export async function serveVoice(path: string, files: R2Bucket, nowMs: number): Promise<Response | null> {
  const id = VOICE_PATH.exec(path)?.[1];
  if (!id) return null;
  const obj = await files.get(`${PREFIX}${id}.mp3`);
  if (!obj || obj.uploaded.getTime() < nowMs - VOICE_TTL_MS) return new Response("Not found.", { status: 404 });
  return new Response(obj.body, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
}

export async function sweepVoice(files: FileStore, nowMs: number): Promise<number> {
  const keys = await files.listOlderThan(PREFIX, nowMs - VOICE_TTL_MS, 100);
  return keys.length > 0 ? files.deleteKeys(keys) : 0;
}
