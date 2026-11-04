import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signBody } from "../agent/lib/auth.js";
import { engineFrom, personIdFor } from "../agent/lib/engine.js";
import { ffmpegWav, handleListen, transcribe, type ListenDeps } from "../agent/lib/listen.js";
import { ENGINE_AGENT_TOKEN, ENGINE_URL, EngineDouble, grantFor } from "./engine-double.js";

const AUDIO_BYTES = new TextEncoder().encode("synthetic-audio-bytes");
const WAV_BYTES = new TextEncoder().encode("RIFFsynthetic-wav");
const deadline = () => Date.now() + 30_000;

type Call = { url: string; init: RequestInit };

// Stands in for the two providers. No test here reaches a real model.
function providers(answers: { meta?: Response | Error; open?: Response | Error }) {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init! });
    const answer = url.includes("/asr/transcribe") ? answers.meta : answers.open;
    if (answer instanceof Error) throw answer;
    return answer ?? new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return { calls, fetchFn };
}

const metaSays = (transcript: string) => Response.json({ sessionId: "s", transcript, audioDurationMs: 1000, turns: [] });
const openSays = (content: string) => Response.json({ choices: [{ message: { content } }] });
const toWav = async () => WAV_BYTES;

function deps(over: Partial<ListenDeps> & { fetchFn: typeof fetch }): ListenDeps {
  return { env: { META_MODEL_API_KEY: "test-meta", OPENROUTER_API_KEY: "test-open" }, toWav, ...over };
}

describe("hearing a voice note", () => {
  it("asks Muse Voice Transcribe first, with a WAV, and only that", async () => {
    const { calls, fetchFn } = providers({ meta: metaSays("my food benefits are ending") });
    expect(await transcribe(AUDIO_BYTES, "audio/x-caf", deadline(), deps({ fetchFn }))).toBe("my food benefits are ending");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.meta.ai/v1/asr/transcribe");
    const form = calls[0]!.init.body as FormData;
    expect(JSON.parse(await (form.get("request") as Blob).text())).toMatchObject({ model: "muse-voice-transcribe-1.0" });
    expect(new TextDecoder().decode(await (form.get("audio") as Blob).arrayBuffer())).toBe("RIFFsynthetic-wav");
  });

  it.each([
    ["answers 402", new Response("billing", { status: 402 })],
    ["cannot be reached", new TypeError("network")],
  ])("falls back to the open-weight model on zero-retention endpoints when Meta %s", async (_name, meta) => {
    const { calls, fetchFn } = providers({ meta, open: openSays(" se me acaban los beneficios ") });
    expect(await transcribe(AUDIO_BYTES, "audio/mp4", deadline(), deps({ fetchFn }))).toBe("se me acaban los beneficios");
    const body = JSON.parse(calls[1]!.init.body as string);
    expect(body.model).toBe("meta/muse-spark-open");
    expect(body.provider).toEqual({ zdr: true, data_collection: "deny" });
    expect(body.messages[0].content[1].input_audio).toEqual({ data: Buffer.from(WAV_BYTES).toString("base64"), format: "wav" });
  });

  it("sends an m4a as it came when nothing can convert it", async () => {
    const { calls, fetchFn } = providers({ meta: metaSays("unused"), open: openSays("hello") });
    expect(await transcribe(AUDIO_BYTES, "audio/x-m4a", deadline(), deps({ fetchFn, toWav: async () => null }))).toBe("hello");
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.messages[0].content[1].input_audio).toEqual({ data: Buffer.from(AUDIO_BYTES).toString("base64"), format: "m4a" });
  });

  it("gives up on a .caf nothing can convert, without calling anyone", async () => {
    const { calls, fetchFn } = providers({});
    expect(await transcribe(AUDIO_BYTES, "audio/x-caf", deadline(), deps({ fetchFn, toWav: async () => null }))).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("gives up when both refuse, when no key is set, and on a type it does not know", async () => {
    const both = providers({ meta: new Response("no", { status: 402 }), open: new Response("no", { status: 402 }) });
    expect(await transcribe(AUDIO_BYTES, "audio/mp4", deadline(), deps({ fetchFn: both.fetchFn }))).toBeNull();
    const none = providers({});
    expect(await transcribe(AUDIO_BYTES, "audio/mp4", deadline(), deps({ fetchFn: none.fetchFn, env: {} }))).toBeNull();
    expect(await transcribe(AUDIO_BYTES, "application/octet-stream", deadline(), deps({ fetchFn: none.fetchFn }))).toBeNull();
    expect(none.calls).toHaveLength(0);
  });

  it("a note with no speech is no words, not a failure", async () => {
    const { fetchFn } = providers({ meta: new Response("no", { status: 402 }), open: openSays("NO_SPEECH") });
    expect(await transcribe(AUDIO_BYTES, "audio/mp4", deadline(), deps({ fetchFn }))).toBe("");
  });
});

const ffmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

describe.skipIf(!ffmpeg)("converting to what Meta takes", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mano-voice-test-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // One second of a synthetic tone, in the container named.
  function tone(name: string, codec: string[]): Uint8Array {
    const path = join(dir, name);
    const made = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", ...codec, path]);
    if (made.status !== 0) throw new Error(`could not make ${name}`);
    return new Uint8Array(readFileSync(path));
  }

  it.each([
    ["note.caf", "caf", ["-c:a", "pcm_s16le"]],
    ["note.m4a", "mov", ["-c:a", "aac"]],
  ])("turns %s into mono 16-bit 24 kHz WAV", async (name, demuxer, codec) => {
    const wav = await ffmpegWav(tone(name, codec), demuxer, 20_000);
    const view = new DataView(wav!.buffer, wav!.byteOffset, wav!.byteLength);
    expect(new TextDecoder().decode(wav!.subarray(0, 4))).toBe("RIFF");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint16(34, true)).toBe(16);
  });

  it("makes nothing of a file that is not audio, and a playlist cannot pick its own demuxer", async () => {
    expect(await ffmpegWav(AUDIO_BYTES, "mov", 20_000)).toBeNull();
    const playlist = new TextEncoder().encode("#EXTM3U\n#EXTINF:1,\nfile:///etc/hosts\n#EXT-X-ENDLIST\n");
    expect(await ffmpegWav(playlist, "mp3", 20_000)).toBeNull();
  });

  it("a missing ffmpeg is no WAV, not an error", async () => {
    vi.stubEnv("MANO_FFMPEG_PATH", join(dir, "no-such-ffmpeg"));
    expect(await ffmpegWav(AUDIO_BYTES, "caf", 5_000)).toBeNull();
    vi.unstubAllEnvs();
  });
});

describe("Channels asking to hear a turn's notes", () => {
  const SECRET = "listen-test-secret";
  const HANDLE = "d".repeat(64);
  const DOC = "g0t1i0-0123456789ab";
  let engine: EngineDouble;
  let grant: string;

  function signed(body: Record<string, unknown>, secret = SECRET): Request {
    const raw = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    return new Request("http://agent.test/channels/mano/listen", {
      method: "POST",
      headers: { "content-type": "application/json", [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: signBody(secret, ts, raw) },
      body: raw,
    });
  }
  const client = () => engineFrom({ baseUrl: ENGINE_URL, agentToken: ENGINE_AGENT_TOKEN, fetchFn: engine.fetch });
  const asked = () => ({ handleHash: HANDLE, generation: 0, grant, documents: [{ id: DOC, mimeType: "audio/mp4" }] });

  beforeEach(async () => {
    engine = new EngineDouble();
    grant = await grantFor(HANDLE);
    engine.putDocument(personIdFor(HANDLE), DOC, AUDIO_BYTES);
    vi.stubGlobal("fetch", engine.fetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reads the stored note and answers with its words", async () => {
    const { fetchFn } = providers({ meta: metaSays("hello there") });
    const res = await handleListen(signed(asked()), { ...deps({ fetchFn }), secret: SECRET, engine: client() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "hello there" });
  });

  it("refuses a request it cannot verify, and another person's grant", async () => {
    const { calls, fetchFn } = providers({ meta: metaSays("hello there") });
    expect((await handleListen(signed(asked(), "wrong"), { ...deps({ fetchFn }), secret: SECRET, engine: client() })).status).toBe(401);
    const other = await handleListen(signed({ ...asked(), handleHash: "a".repeat(64) }), { ...deps({ fetchFn }), secret: SECRET, engine: client() });
    expect(await other.json()).toEqual({ text: "" });
    expect(calls).toHaveLength(0);
  });

  it("answers no words when nothing could listen, and never logs what was said", async () => {
    const log = vi.spyOn(console, "log");
    const { fetchFn } = providers({ meta: metaSays("a very private sentence") });
    await handleListen(signed(asked()), { ...deps({ fetchFn }), secret: SECRET, engine: client() });
    expect(JSON.stringify(log.mock.calls)).not.toContain("private");
    log.mockRestore();
    const down = providers({ meta: new Response("no", { status: 402 }), open: new Response("no", { status: 402 }) });
    const res = await handleListen(signed(asked()), { ...deps({ fetchFn: down.fetchFn }), secret: SECRET, engine: client() });
    expect(await res.json()).toEqual({ text: "" });
  });
});
