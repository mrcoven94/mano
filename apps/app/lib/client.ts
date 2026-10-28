// Picks the engine the app talks to. With EXPO_PUBLIC_ENGINE_URL set the
// app uses the live engine; otherwise it uses the stand-in with recorded
// synthetic responses and says so on screen. When the engine merges, this
// file is the only place that changes.

import { CryptoDigestAlgorithm, digest } from "expo-crypto";
import { b64decode } from "./base64";
import { engineUrl } from "./config";
import { EngineClient } from "./api/engine";
import { StandInClient, type Hasher } from "./api/standin";
import type { EngineMode, ManoClient } from "./api/types";

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const expoSha256B64: Hasher = async (bytesB64: string) => {
  const decoded = b64decode(bytesB64);
  const copy = new Uint8Array(decoded.length);
  copy.set(decoded);
  const out = await digest(CryptoDigestAlgorithm.SHA256, copy.buffer);
  return hexEncode(new Uint8Array(out));
};

export interface ResolvedClient {
  client: ManoClient;
  mode: EngineMode;
}

let cached: ResolvedClient | null = null;

export function resolveClient(): ResolvedClient {
  if (cached) return cached;
  const url = engineUrl();
  if (url) {
    console.info(`[mano] engine: live at ${url}`);
    cached = { client: new EngineClient({ baseUrl: url, sha256B64: expoSha256B64 }), mode: "live" };
  } else {
    console.info("[mano] engine: stand-in (recorded synthetic responses)");
    cached = { client: new StandInClient({ sha256B64: expoSha256B64 }), mode: "stand-in" };
  }
  return cached;
}

// Tests and previews reset the singleton between cases.
export function resetClient(): void {
  cached = null;
}
