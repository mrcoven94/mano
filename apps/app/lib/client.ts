// Picks the engine the app talks to. An EXPO_PUBLIC_ENGINE_URL always
// wins; otherwise the stand-in runs only with EXPO_PUBLIC_DEMO_MODE,
// and anything else throws at start instead of demoing by accident.
// When the engine merges, set the URL and the app switches.

import { CryptoDigestAlgorithm, digest } from "expo-crypto";
import { b64decode } from "./base64";
import { demoMode, engineUrl } from "./config";
import { decideEngineMode } from "./mode";
import { EngineClient } from "./api/engine";
import { StandInClient, type Hasher } from "./api/standin";
import type { EngineMode, ManoClient } from "./api/types";

export class ConfigError extends Error {
  constructor() {
    super("Set EXPO_PUBLIC_ENGINE_URL or EXPO_PUBLIC_DEMO_MODE=true.");
    this.name = "ConfigError";
  }
}

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
  const decision = decideEngineMode({ engineUrl: url, demo: demoMode() });
  if ("error" in decision) throw new ConfigError();
  if (decision.mode === "live" && url) {
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
