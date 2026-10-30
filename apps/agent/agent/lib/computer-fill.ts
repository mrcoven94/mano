// Fills a form on the person's own computer: the hosted desktop (Modal)
// or, for local runs, the Playwright stand-in. The model types the
// values the person will approve into the real form and moves to the
// form's next step, so the portal's own checks run on them. Nothing is
// submitted here; filing happens only through Engine after a YES.
import { FetchModelClient, computerFromEnv, runLoop, type Computer, type ComputerAction, type ModelClient } from "@mano/computer";

import type { FormSpec } from "./forms.js";

export type FillOutcome =
  | { status: "filled"; steps: number; ms: number }
  | { status: "rejected"; message: string; steps: number; ms: number }
  | { status: "unavailable"; reason: string }
  | { status: "failed"; reason: string; ms: number };

export interface FillDeps {
  computer: Computer;
  model: ModelClient;
  modelId: string;
  deadlineMs: number;
}

// Inside the 90-second turn, with room for the reply around it.
const DEFAULT_DEADLINE_MS = 60_000;
const DEFAULT_MODEL = "muse-spark-1.3";
const DEFAULT_BASE_URL = "https://api.meta.ai/v1";

// The computer and model this deployment fills forms with, or why there is none.
export function fillDepsFromEnv(personId: string, env: NodeJS.ProcessEnv = process.env): FillDeps | { unavailable: string } {
  if (!env.META_MODEL_API_KEY) return { unavailable: "no model key" };
  if (!env.MODAL_COMPUTER_URL && env.COMPUTER_BACKEND !== "playwright") return { unavailable: "no computer configured" };
  const computer = computerFromEnv({
    COMPUTER_BACKEND: env.MODAL_COMPUTER_URL ? "modal" : "playwright",
    MODAL_COMPUTER_URL: env.MODAL_COMPUTER_URL,
    MODAL_COMPUTER_TOKEN: env.MODAL_COMPUTER_TOKEN,
    COMPUTER_PROFILE: personId,
    COMPUTER_PROFILE_DIR: env.COMPUTER_PROFILE_DIR,
  });
  const model = new FetchModelClient({ baseUrl: env.MANO_MODEL_BASE_URL ?? DEFAULT_BASE_URL, apiKey: env.META_MODEL_API_KEY });
  const deadline = Number(env.MANO_FILL_DEADLINE_MS);
  return {
    computer,
    model,
    modelId: env.MANO_COMPUTER_MODEL ?? DEFAULT_MODEL,
    deadlineMs: Number.isFinite(deadline) && deadline > 0 ? deadline : DEFAULT_DEADLINE_MS,
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
    "When the form's next step appears, stop and reply with exactly: ACCEPTED",
    "If the form shows an error instead, stop and reply with REJECTED: and the error text.",
  ].join("\n");
}

class Deadline extends Error {}

export async function fillOnComputer(form: FormSpec, values: Record<string, string>, portalUrl: string, deps: FillDeps): Promise<FillOutcome> {
  const started = Date.now();
  const typed: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Deadline()), deps.deadlineMs);
  });
  try {
    const run = (async () => {
      await deps.computer.goto(`${portalUrl.replace(/\/$/, "")}${form.path}`);
      return runLoop(deps.computer, deps.model, taskText(form, values), {
        model: deps.modelId,
        maxSteps: 8,
        instructions: "These fields do not depend on each other: fill all of them in one batch of click and type actions, then click Continue.",
        onTurn: (turn: { step: number; call: ComputerAction[] } | { step: number; message: string }) => {
          if ("call" in turn) for (const a of turn.call) if (a.type === "type") typed.push(a.text);
        },
      });
    })();
    // A run past the deadline ends when its computer is closed below.
    run.catch(() => undefined);
    const outcome = await Promise.race([run, deadline]);
    const ms = Date.now() - started;
    if (outcome.status !== "done") return { status: "failed", reason: outcome.status, ms };
    const reply = outcome.message.trim();
    if (/^REJECTED:/i.test(reply)) return { status: "rejected", message: reply.replace(/^REJECTED:\s*/i, ""), steps: outcome.steps, ms };
    if (!/^ACCEPTED\b/i.test(reply)) return { status: "failed", reason: "unclear report", ms };
    // The values the person approves are the ones typed: each must have
    // gone into the form exactly as written.
    const all = typed.join("\n");
    const untyped = form.fields.filter((f) => !all.includes(typedValue(f.name, values[f.name] ?? "")));
    if (untyped.length > 0) return { status: "failed", reason: `not typed: ${untyped.map((f) => f.name).join(",")}`, ms };
    return { status: "filled", steps: outcome.steps, ms };
  } catch (err) {
    const ms = Date.now() - started;
    return { status: "failed", reason: err instanceof Deadline ? "deadline" : "error", ms };
  } finally {
    clearTimeout(timer);
    await deps.computer.close().catch(() => undefined);
  }
}
