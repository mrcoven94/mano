import type { TryLogged, TryScenario } from "@mano/protocol";

/* The judge demo's API on Engine. Every key stays there; this page only sends a scenario name and presses. */
export const TRY_API = (process.env.NEXT_PUBLIC_TRY_API_URL ?? "").replace(/\/$/, "");
/* Recorded responses for building the page while the model account is down. Only in `next dev`: a production build
   drops this path, so the live page can never show them. */
export const TRY_DEV_RECORDED = process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_TRY_DEV_RECORDED === "1";

export type Refusal = "paused" | "rate" | "busy" | "full";
export type Started = { runId: string; needsGuardian: boolean } | { refused: Refusal };
export type Next = "auto" | "yes" | "end" | "busy";
export type GuardianState = { state: "ready" | "starting" | "failed"; secondsLeft: number };

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${TRY_API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const startRun = (scenario: TryScenario, session: string) => post<Started>("/try/runs", { scenario, session });
export const wakeGuardian = (runId: string) => post<GuardianState>(`/try/runs/${runId}/guardian`);
export const nextLeg = (runId: string, press?: "yes") => post<{ next: Next }>(`/try/runs/${runId}/next`, press ? { press } : {});

export async function readEvents(runId: string, after: number): Promise<{ events: TryLogged[]; done: boolean }> {
  const res = await fetch(`${TRY_API}/try/runs/${runId}?after=${after}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as { events: TryLogged[]; done: boolean };
}

export async function readStatus(): Promise<{ enabled: boolean; paused: boolean }> {
  const res = await fetch(`${TRY_API}/try/status`, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as { enabled: boolean; paused: boolean };
}

/* A recording of a real run, committed once one exists: the same event log, with its screens beside it. */
export type Recording = { recordedAt: string; scenario: TryScenario; events: TryLogged[] };

export async function readRecording(): Promise<Recording | null> {
  try {
    const res = await fetch("/try/recording/run.json", { cache: "no-store" });
    return res.ok ? ((await res.json()) as Recording) : null;
  } catch {
    return null;
  }
}
