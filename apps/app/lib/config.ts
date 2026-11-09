// App configuration from the environment. The app refuses to start
// unless EXPO_PUBLIC_ENGINE_URL or EXPO_PUBLIC_DEMO_MODE is set; see
// .env.example for the full list.

const TRAILING_SLASHES = /\/+$/;

export function engineUrl(): string | null {
  const raw = process.env.EXPO_PUBLIC_ENGINE_URL;
  if (!raw || raw.trim() === "") return null;
  return raw.trim().replace(TRAILING_SLASHES, "");
}

// Explicit opt-in to the stand-in engine. Nothing else enables it.
export function demoMode(): boolean {
  return process.env.EXPO_PUBLIC_DEMO_MODE === "true";
}
