// Fills a form on the person's own computer: the hosted desktop (Modal)
// or, for local runs, the Playwright stand-in. The model is the agent's:
// Meta's open-weight model when MANO_MODEL_PROVIDER=openrouter, otherwise
// the Meta Model API. Each fill opens a fresh draft on the sandbox portal,
// the model types the values the person will
// approve and moves to the form's next step, which saves the draft. The
// portal's own checks run on the values. The fill then reads the draft
// back from the portal and returns exactly what it saved; any difference
// from the intended values fails the fill. The desktop can only save
// drafts: filing happens only through Engine after a YES.
//
// A filled outcome carries its replay: each screen of the run up to the
// whole form filled, captioned with the field it shows filled, so the
// person can see what Mano did before they say yes.
import { randomBytes } from "node:crypto";

import {
  FILL_DEADLINE_MS,
  FILL_INSTRUCTIONS,
  FILL_MAX_STEPS,
  FetchModelClient,
  OpenWeightModelClient,
  computerFromEnv,
  editsForm,
  fillTask,
  recordFrames,
  runLoop,
  type Computer,
  type ComputerAction,
  type Frame,
  type ModelClient,
} from "@mano/computer";

import type { FormSpec } from "./forms.js";
import { selectModelRoute } from "./muse.js";

// One screen of a fill, as the person sees it on the replay page. focus:
// where Mano clicked before it typed, in screenshot pixels, so the page
// can show that field up close.
export interface ReplayStep {
  caption: string;
  png: Uint8Array;
  focus: { x: number; y: number } | null;
}

export type FillOutcome =
  // saved: the draft as the portal holds it, field by field.
  | { status: "filled"; saved: Record<string, string>; replay: ReplayStep[]; steps: number; ms: number }
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

const DEFAULT_MODEL = "muse-spark-1.3";
const CLOSE_WAIT_MS = 3_000;
const READ_TIMEOUT_MS = 10_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TRAILING_SLASH = /\/$/;
const REJECTED_PREFIX = /^REJECTED:\s*/i;

// The computer and model this deployment fills forms with, or why there is none.
export function fillDepsFromEnv(personId: string, env: NodeJS.ProcessEnv = process.env): FillDeps | { unavailable: string } {
  const route = selectModelRoute({}, env);
  if (!route.apiKey) return { unavailable: "no model key" };
  // The Meta path's hosted computer tool does not exist on Modal, and the
  // open-weight client below is OpenRouter's.
  if (route.name === "modal") return { unavailable: "no computer on this model route" };
  if (!env.SANDBOX_PORTAL_DRAFT_TOKEN) return { unavailable: "no draft token" };
  if (!env.MODAL_COMPUTER_URL && env.COMPUTER_BACKEND !== "playwright") return { unavailable: "no computer configured" };
  const computer = computerFromEnv({
    COMPUTER_BACKEND: env.MODAL_COMPUTER_URL ? "modal" : "playwright",
    MODAL_COMPUTER_URL: env.MODAL_COMPUTER_URL,
    MODAL_COMPUTER_TOKEN: env.MODAL_COMPUTER_TOKEN,
    COMPUTER_PERSON_ID: personId,
    COMPUTER_PROFILE_DIR: env.COMPUTER_PROFILE_DIR,
  });
  const openWeight = route.name === "openrouter";
  const model = openWeight ? new OpenWeightModelClient({ apiKey: route.apiKey }) : new FetchModelClient({ baseUrl: route.baseURL, apiKey: route.apiKey });
  const deadline = Number(env.MANO_FILL_DEADLINE_MS);
  return {
    computer,
    model,
    modelId: openWeight ? route.modelId : (env.MANO_COMPUTER_MODEL ?? DEFAULT_MODEL),
    deadlineMs: Number.isFinite(deadline) && deadline > 0 ? deadline : FILL_DEADLINE_MS,
    draftToken: env.SANDBOX_PORTAL_DRAFT_TOKEN,
  };
}

// What the person's values look like typed into the form.
export function typedValue(name: string, value: string): string {
  const iso = name === "dateOfBirth" ? ISO_DATE.exec(value) : null;
  return iso ? `${iso[2]}/${iso[3]}/${iso[1]}` : value;
}

// Engine keeps at most this many steps of one fill.
const MAX_REPLAY_STEPS = 24;

// The screens up to the last edit, which shows the whole form as it was
// saved, corrections included. Captions name the field, never its value:
// the value is on the screen, and the page lists what Engine will send.
// focus: the last click before the frame's last edit, carried over from
// earlier frames, since a value is often typed in a piece of its own.
export function replayOf(frames: Frame[], form: FormSpec, values: Record<string, string>): ReplayStep[] {
  const labelOf = new Map(form.fields.map((f) => [typedValue(f.name, values[f.name] ?? "").trim(), f.label]));
  let lastClick: { x: number; y: number } | null = null;
  let end = frames.length;
  const steps = frames.map((frame, i) => {
    let focus: { x: number; y: number } | null = null;
    for (const a of frame.actions) {
      if (a.type === "click" || a.type === "double_click") lastClick = { x: Math.round(a.x), y: Math.round(a.y) };
      if (editsForm(a)) {
        focus = lastClick;
        end = i + 1;
      }
    }
    return { caption: captionFor(frame.actions, labelOf), png: frame.png, focus };
  });
  return steps.slice(0, end).slice(-MAX_REPLAY_STEPS);
}

// Says what ran on the one line every replay shows first. Both model paths
// fit it, and it names neither: this page is for the person.
const OPENED_CAPTION = "Mano opened the form. An AI model chose each step below from what it saw on the screen.";

function captionFor(actions: ComputerAction[], labelOf: Map<string, string>): string {
  if (actions.length === 0) return OPENED_CAPTION;
  const typed = actions.filter((a): a is Extract<ComputerAction, { type: "type" }> => a.type === "type").pop();
  if (typed) {
    const label = labelOf.get(typed.text.trim());
    return label ? `Mano filled in "${label}".` : "Mano typed into the form.";
  }
  if (actions.some(editsForm)) return "Mano corrected the field.";
  if (actions.some((a) => a.type === "scroll")) return "Mano scrolled the form.";
  if (actions.some((a) => a.type === "click" || a.type === "double_click")) return "Mano clicked on the form.";
  return "Mano waited for the form.";
}

class Deadline extends Error {}

class DraftReadFailed extends Error {
  constructor(readonly status: number) {
    super(`draft read ${status}`);
  }
}

// The draft as the portal saved it, or null when it has none by this id.
async function readDraft(portalUrl: string, id: string, deps: FillDeps): Promise<Record<string, string> | null> {
  const res = await (deps.portalFetch ?? globalThis.fetch)(`${portalUrl.replace(TRAILING_SLASH, "")}/drafts/${id}`, {
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

// layout: the address of one of the portal's test layouts of this form, or "".
export async function fillOnComputer(form: FormSpec, values: Record<string, string>, portalUrl: string, deps: FillDeps, layout = ""): Promise<FillOutcome> {
  const started = Date.now();
  // Fresh per fill, so a draft read back can only be this fill's.
  const draftId = randomBytes(32).toString("hex");
  const { computer, frames } = recordFrames(deps.computer);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Deadline()), deps.deadlineMs);
  });
  try {
    const run = (async (): Promise<FillOutcome> => {
      const page = new URL(`${portalUrl.replace(TRAILING_SLASH, "")}${layout}${form.path}`);
      page.searchParams.set("draft", draftId);
      await computer.goto(page.toString());
      const task = fillTask(form.fields.map((f) => ({ label: f.label, value: typedValue(f.name, values[f.name] ?? "") })));
      const outcome = await runLoop(computer, deps.model, task, { model: deps.modelId, maxSteps: FILL_MAX_STEPS, instructions: FILL_INSTRUCTIONS });
      const ms = () => Date.now() - started;
      if (outcome.status === "safety_check") return { status: "safety_check", codes: outcome.checks.map((c) => c.code), steps: outcome.steps, ms: ms() };
      if (outcome.status !== "done") return { status: "failed", reason: outcome.status, ms: ms() };
      const reply = outcome.message.trim();
      if (REJECTED_PREFIX.test(reply)) return { status: "rejected", message: reply.replace(REJECTED_PREFIX, ""), steps: outcome.steps, ms: ms() };
      // What the person approves is what the portal saved, field for field.
      const saved = await readDraft(portalUrl, draftId, deps);
      if (!saved) return { status: "failed", reason: "no draft saved", ms: ms() };
      const differs = form.fields.filter((f) => saved[f.name] !== values[f.name]);
      if (differs.length > 0) return { status: "failed", reason: `saved differs: ${differs.map((f) => f.name).join(",")}`, ms: ms() };
      return {
        status: "filled",
        saved: Object.fromEntries(form.fields.map((f) => [f.name, saved[f.name]!])),
        replay: replayOf(frames(), form, values),
        steps: outcome.steps,
        ms: ms(),
      };
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
