// App configuration from the environment. Every value has a safe local
// default; see .env.example for the full list.

export function engineUrl(): string | null {
  const raw = process.env.EXPO_PUBLIC_ENGINE_URL;
  if (!raw || raw.trim() === "") return null;
  return raw.trim().replace(/\/+$/, "");
}

export function easProjectId(): string | null {
  const raw = process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
  if (!raw || raw.trim() === "") return null;
  return raw.trim();
}

// Explicit opt-in to the stand-in engine. Nothing else enables it.
export function demoMode(): boolean {
  return process.env.EXPO_PUBLIC_DEMO_MODE === "true";
}
