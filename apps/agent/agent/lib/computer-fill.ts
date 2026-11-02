// Fills a form on the person's own computer: the hosted desktop (Modal)
// or, for local runs, the Playwright stand-in. Each fill opens a fresh
// draft on the sandbox portal, the model types the values the person will
// approve and moves to the form's next step, which saves the draft. The
// portal's own checks run on the values. The fill then reads the draft
// back from the portal and returns exactly what it saved; any difference
// from the intended values fails the fill. The desktop can only save
// drafts: filing happens only through Engine after a YES.
import { randomBytes } from "node:crypto";

import { FetchModelClient, computerFromEnv, runLoop, type Computer, type ModelClient } from "@mano/computer";

import type { FormSpec } from "./forms.js";

export type FillOutcome =
  // saved: the draft as the portal holds it, field by field.
  | { status: "filled"; saved: Record<string, string>; steps: number; ms: number }
  | { status: "rejected"; message: string; steps: number; ms: number }
  // The model flagged its next actions; nothing ran. Codes only, never messages.
  | { status: "safety_check"; codes: string[]; steps: number; ms: number }
  | { status: "failed"; reason: string; ms: number };

export interface FillDeps {
  computer: Computer;
  model: ModelClient;
  modelId: string;
  deadlineMs: number;
  // Reads drafts back from the portal (GET /drafts/<id>). It cannot file.
  draftToken: string;
  portalFetch?: typeof fetch;
}

// Inside the 90-second turn, with room for the reply around it.
const DEFAULT_DEADLINE_MS = 60_000;
const DEFAULT_MODEL = "muse-spark-1.3";
const CLOSE_WAIT_MS = 3_000;
const READ_TIMEOUT_MS = 10_000;
const DEFAULT_BASE_URL = "https://api.meta.ai/v1";

// The computer and model this deployment fills forms with, or why there is none.
export function fillDepsFromEnv(personId: string, env: NodeJS.ProcessEnv = process.env): FillDeps | { unavailable: string } {
  if (!env.META_MODEL_API_KEY) return { unavailable: "no model key" };
  if (!env.SANDBOX_PORTAL_DRAFT_TOKEN) return { unavailable: "no draft token" };
  if (!env.MODAL_COMPUTER_URL && env.COMPUTER_BACKEND !== "playwright") return { unavailable: "no computer configured" };
  const computer = computerFromEnv({
    COMPUTER_BACKEND: env.MODAL_COMPUTER_URL ? "modal" : "playwright",
    MODAL_COMPUTER_URL: env.MODAL_COMPUTER_URL,
    MODAL_COMPUTER_TOKEN: env.MODAL_COMPUTER_TOKEN,
    COMPUTER_PERSON_ID: personId,
    COMPUTER_PROFILE_DIR: env.COMPUTER_PROFILE_DIR,
  });
  const model = new FetchModelClient({ baseUrl: env.MANO_MODEL_BASE_URL ?? DEFAULT_BASE_URL, apiKey: env.META_MODEL_API_KEY });
  const deadline = Number(env.MANO_FILL_DEADLINE_MS);
  return {
    computer,
    model,
    modelId: env.MANO_COMPUTER_MODEL ?? DEFAULT_MODEL,
    deadlineMs: Number.isFinite(deadline) && deadline > 0 ? deadline : DEFAULT_DEADLINE_MS,
    draftToken: env.SANDBOX_PORTAL_DRAFT_TOKEN,
  };
}

// What the person's values look like typed into the form.
export function typedValue(name: string, value: string): string {
  const iso = name === "dateOfBirth" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  return iso ? `${iso[2]}/${iso[3]}/${iso[1]}` : value;
}

function taskText(form: FormSpec, values: Record<string, string>): string {
  const lines = form.fields.map((f) => `${f.label}: ${typedValue(f.name, values[f.name] ?? "")}`);
  return [
    "Fill out the form open in this browser with exactly these values, then continue to the form's next step. Do not submit anything.",
    ...lines,
    "Type each value exactly as written. For a date field, click it, press Ctrl+A, then type the date.",
    "A long value can look cut off in a narrow field; that is fine, do not retype it.",
    "When the form's next step appears, stop and reply with exactly: ACCEPTED",
    "If the form shows an error instead, stop and reply with REJECTED: and the error text.",
  ].join("\n");
}

class Deadline extends Error {}

class DraftReadFailed extends Error {
  constructor(readonly status: number) {
    super(`draft read ${status}`);
  }
}

// The draft as the portal saved it, or null when it has none by this id.
async function readDraft(portalUrl: string, id: string, deps: FillDeps): Promise<Record<string, string> | null> {
  const res = await (deps.portalFetch ?? globalThis.fetch)(`${portalUrl.replace(/\/$/, "")}/drafts/${id}`, {
    headers: { authorization: `Bearer ${deps.draftToken}` },
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new DraftReadFailed(res.status);
  const body = (await res.json()) as { id?: unknown; household?: unknown };
  if (body.id !== id || typeof body.household !== "object" || body.household === null) throw new DraftReadFailed(502);
  const saved: Record<string, string> = {};
  for (const [k, v] of Object.entries(body.household)) if (typeof v === "string") saved[k] = v;
  return saved;
}

export async function fillOnComputer(form: FormSpec, values: Record<string, string>, portalUrl: string, deps: FillDeps): Promise<FillOutcome> {
  const started = Date.now();
  // Fresh per fill, so a draft read back can only be this fill's.
  const draftId = randomBytes(32).toString("hex");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Deadline()), deps.deadlineMs);
  });
  try {
    const run = (async (): Promise<FillOutcome> => {
      const page = new URL(`${portalUrl.replace(/\/$/, "")}${form.path}`);
      page.searchParams.set("draft", draftId);
      await deps.computer.goto(page.toString());
      const outcome = await runLoop(deps.computer, deps.model, taskText(form, values), {
        model: deps.modelId,
        maxSteps: 8,
        instructions: "These fields do not depend on each other: fill all of them in one batch of click and type actions, then click Continue.",
      });
      const ms = () => Date.now() - started;
      if (outcome.status === "safety_check") return { status: "safety_check", codes: outcome.checks.map((c) => c.code), steps: outcome.steps, ms: ms() };
      if (outcome.status !== "done") return { status: "failed", reason: outcome.status, ms: ms() };
      const reply = outcome.message.trim();
      if (/^REJECTED:/i.test(reply)) return { status: "rejected", message: reply.replace(/^REJECTED:\s*/i, ""), steps: outcome.steps, ms: ms() };
      // What the person approves is what the portal saved, field for field.
      const saved = await readDraft(portalUrl, draftId, deps);
      if (!saved) return { status: "failed", reason: "no draft saved", ms: ms() };
      const differs = form.fields.filter((f) => saved[f.name] !== values[f.name]);
      if (differs.length > 0) return { status: "failed", reason: `saved differs: ${differs.map((f) => f.name).join(",")}`, ms: ms() };
      return { status: "filled", saved: Object.fromEntries(form.fields.map((f) => [f.name, saved[f.name]!])), steps: outcome.steps, ms: ms() };
    })();
    // A run past the deadline ends when its computer is closed below.
    run.catch(() => undefined);
    return await Promise.race([run, deadline]);
  } catch (err) {
    const reason = err instanceof Deadline ? "deadline" : err instanceof DraftReadFailed ? err.message : "error";
    return { status: "failed", reason, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
    // Stopping a hosted desktop can take longer than the turn has left;
    // wait briefly, and the service's own cap stops it otherwise.
    const closing = deps.computer.close().catch(() => undefined);
    await Promise.race([closing, new Promise((r) => setTimeout(r, CLOSE_WAIT_MS))]);
  }
}
