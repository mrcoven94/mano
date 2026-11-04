import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import { describe, it } from "vitest";
import type { ComputerAction } from "../src/actions";
import { runLoop, type LoopOutcome } from "../src/loop";
import { FetchModelClient, type ModelClient, type ResponsePayload } from "../src/model";
import { OPEN_WEIGHT_MODEL_ID, OpenWeightModelClient } from "../src/open-weight";
import { PlaywrightComputer } from "../src/playwright";

/*
 * Does a fill work on a layout it has never seen? Runs one fill on each fixed
 * layout of the sandbox portal and on fresh seeded ones with a synthetic person,
 * reads back what the portal saved, and prints a row per layout. Misses stay in
 * the table. Filling saves a draft and files nothing.
 *
 * Run it against a sandbox portal you started, with its draft token set:
 *
 *   MEASURE_PORTAL_URL=http://127.0.0.1:8788 SANDBOX_PORTAL_DRAFT_TOKEN=... \
 *     MEASURE_MODEL=standin pnpm --filter @mano/computer probe:live layouts
 *
 * MEASURE_MODEL: standin (no model, no credit: it reads the page's HTML, so it
 * proves the plumbing and measures nothing), meta (Muse Spark 1.3, needs
 * META_MODEL_API_KEY), open (Muse Spark Open, needs OPENROUTER_API_KEY) or route
 * (whichever the agent's route picks: open with MANO_MODEL_PROVIDER=openrouter).
 * MEASURE_SCRAMBLES: how many seeded layouts, 0 to 5, default 5.
 * MEASURE_SEEDS: comma separated seeds to rerun; default is new ones each run.
 * MEASURE_OUT: a folder for results.json and each layout's last screen.
 * MEASURE_STANDIN_SWAP=1: the stand-in types two values into each other's
 * fields, to show the read-back catches a miss.
 */
const PORTAL = (process.env["MEASURE_PORTAL_URL"] ?? "").replace(/\/$/, "");
const FIXED_LAYOUTS = ["larkmoor", "quillhaven", "tern-valley", "northbrine", "brambleford"];
const MAX_SCRAMBLES = 5;
const MAX_STEPS = 20;
const LAYOUT_DEADLINE_MS = 180_000;
// What the agent's fill allows today (apps/agent/agent/lib/computer-fill.ts).
const AGENT_STEPS = 8;
const AGENT_MS = 60_000;
const META_MODEL_ID = "muse-spark-1.3";
const META_BASE_URL = "https://api.meta.ai/v1";

// A synthetic person, and the words the agent's form spec uses for each field.
const PERSON: Array<{ name: string; label: string; value: string; typed?: string }> = [
  { name: "caseNumber", label: "Case number", value: "LM-RENEW-0042117" },
  { name: "fullName", label: "Full legal name", value: "Rosa Testcase" },
  { name: "dateOfBirth", label: "Date of birth", value: "1988-04-12", typed: "04/12/1988" },
  { name: "address", label: "Mailing address", value: "100 Sample St, Larkmoor, ZZ 00000" },
  { name: "phone", label: "Phone number", value: "253-555-0142" },
  { name: "householdSize", label: "People in household", value: "3" },
  { name: "monthlyIncome", label: "Monthly income ($)", value: "2329" },
];
const typedOf = (field: (typeof PERSON)[number]) => field.typed ?? field.value;

// No layout's words are in here: the person's values, and what the end looks like.
const TASK = [
  "Fill out the form open in this browser with exactly these values. Do not submit anything else.",
  ...PERSON.map((f) => `${f.label}: ${typedOf(f)}`),
  "This form is new to you. It may word these fields differently, ask them in another order, spread them over several steps, or keep them in sections you have to open. Match each value to the field that means the same thing.",
  "Type each value exactly as written. For a date field, click it, press Ctrl+A, then type the date.",
  "Enter every value, then press the button that moves on. When a page asks you to attach documents, stop and reply with exactly: ACCEPTED",
  "If the form shows an error instead, stop and reply with REJECTED: and the error text.",
].join("\n");

function modelFromEnv(): { label: string; id: string; client?: ModelClient } {
  const wanted = process.env["MEASURE_MODEL"] ?? "standin";
  const openRoute = wanted === "open" || (wanted === "route" && process.env["MANO_MODEL_PROVIDER"] === "openrouter" && !!process.env["OPENROUTER_API_KEY"]);
  if (openRoute) {
    const apiKey = process.env["OPENROUTER_API_KEY"];
    if (!apiKey) throw new Error("MEASURE_MODEL=open needs OPENROUTER_API_KEY");
    return { label: OPEN_WEIGHT_MODEL_ID, id: OPEN_WEIGHT_MODEL_ID, client: new OpenWeightModelClient({ apiKey }) };
  }
  if (wanted === "meta" || wanted === "route") {
    const apiKey = process.env["META_MODEL_API_KEY"];
    if (!apiKey) throw new Error(`MEASURE_MODEL=${wanted} needs META_MODEL_API_KEY`);
    return { label: META_MODEL_ID, id: META_MODEL_ID, client: new FetchModelClient({ baseUrl: process.env["MANO_MODEL_BASE_URL"] ?? META_BASE_URL, apiKey }) };
  }
  if (wanted !== "standin") throw new Error(`MEASURE_MODEL must be standin, meta, open or route, not ${wanted}`);
  return { label: "stand-in", id: "stand-in" };
}

interface Screen {
  ended?: string;
  scrollBy?: number;
  field?: { name: string; x: number; y: number };
  click?: { x: number; y: number };
}

// Runs in the page. Plain JavaScript, because this package has no DOM types.
const READ_SCREEN = `(names) => {
  const inView = (el, x, y) => {
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) return { scrollBy: Math.round(r.top - window.innerHeight / 2) };
    return { click: { x: Math.round(r.left + r.width * x), y: Math.round(r.top + r.height * y) } };
  };
  const all = (selector) => Array.from(document.querySelectorAll(selector));
  const error = document.querySelector(".error");
  if (error) return { ended: "REJECTED: " + error.textContent };
  if (document.querySelector("input[type=file]")) return { ended: "ACCEPTED" };
  const empty = all("input").find((i) => names.includes(i.name) && !i.value && i.checkVisibility());
  if (empty) {
    const place = inView(empty, empty.type === "date" ? 0.05 : 0.5, 0.5);
    return place.click ? { field: { name: empty.name, ...place.click } } : place;
  }
  const closed = all("details:not([open]) > summary")[0];
  if (closed) return inView(closed, 0.1, 0.5);
  const button = all("button.btn:not(.quiet)").find((b) => b.checkVisibility());
  return button ? inView(button, 0.5, 0.5) : { ended: "REJECTED: nothing left to press" };
}`;

/** Works the real page with real mouse and keyboard, but finds fields in the HTML. It proves the plumbing and measures nothing. */
class StandInModel implements ModelClient {
  private turn = 0;
  private swap = process.env["MEASURE_STANDIN_SWAP"] === "1";

  constructor(private page: () => Page) {}

  // A click that navigates returns before the page changes, and that page can go away mid-read.
  private async read(): Promise<Screen> {
    const script = `(${READ_SCREEN})(${JSON.stringify(PERSON.map((f) => f.name))})`;
    try {
      return await this.page().evaluate<Screen>(script);
    } catch {
      await this.page().waitForLoadState("load");
      return this.page().evaluate<Screen>(script);
    }
  }

  async createResponse(): Promise<ResponsePayload> {
    const screen = await this.read();
    const id = `standin-${++this.turn}`;
    if (screen.ended) {
      return { id, status: "completed", output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: screen.ended }] }] };
    }
    const value = (name: string): string => {
      const swapped = this.swap && name === "phone" ? "address" : this.swap && name === "address" ? "phone" : name;
      return typedOf(PERSON.find((f) => f.name === swapped)!);
    };
    const actions =
      screen.scrollBy !== undefined
        ? [{ type: "scroll", x: 640, y: 400, scroll_x: 0, scroll_y: screen.scrollBy }]
        : screen.field
          ? [{ type: "click", button: "left", x: screen.field.x, y: screen.field.y }, { type: "type", text: value(screen.field.name) }]
          : [{ type: "click", button: "left", x: screen.click!.x, y: screen.click!.y }];
    return { id, status: "completed", output: [{ type: "computer_call", id, call_id: id, actions, pending_safety_checks: [], status: "completed" }] };
  }
}

interface Row {
  layout: string;
  model: string;
  outcome: string;
  correct: number;
  missed: string[];
  seconds: number;
  steps: number;
}

async function readDraft(id: string, token: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${PORTAL}/drafts/${id}`, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`draft read answered ${res.status}, so nothing was measured`);
  return ((await res.json()) as { household: Record<string, unknown> }).household;
}

function outcomeWords(outcome: LoopOutcome): string {
  if (outcome.status !== "done") return outcome.status;
  const reply = outcome.message.trim();
  return /^ACCEPTED/i.test(reply) ? "accepted" : /^REJECTED:/i.test(reply) ? "rejected" : "other reply";
}

class OutOfCredit extends Error {}

// A screenshot taken while a click's navigation is starting can hang until
// Playwright's 30 second timeout, on any layout. Local Chromium only, so it
// would measure the stand-in browser and not the fill. Each step's wall time
// includes this wait.
const SETTLE_MS = 300;

class SettledComputer extends PlaywrightComputer {
  override async act(actions: ComputerAction[]): Promise<void> {
    await super.act(actions);
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  }
}

async function fillOne(layout: string, model: ReturnType<typeof modelFromEnv>, token: string, out: string | undefined): Promise<Row> {
  const draft = randomBytes(32).toString("hex");
  const computer = new SettledComputer({ allowedOrigins: [new URL(PORTAL).origin] });
  // Only the stand-in looks inside the page.
  const client = model.client ?? new StandInModel(() => (computer as unknown as { launched: { page: Page } }).launched.page);
  const started = performance.now();
  let steps = 0;
  let outcome: string;
  let outOfCredit = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await computer.goto(`${PORTAL}${layout}/apply?draft=${draft}`);
    const run = runLoop(computer, client, TASK, { model: model.id, maxSteps: MAX_STEPS, onTurn: (turn) => (steps = turn.step) });
    run.catch(() => undefined);
    const deadline = new Promise<"deadline">((resolve) => (timer = setTimeout(() => resolve("deadline"), LAYOUT_DEADLINE_MS)));
    const result = await Promise.race([run, deadline]);
    outcome = result === "deadline" ? result : outcomeWords(result);
    if (result !== "deadline") steps = result.steps;
  } catch (err) {
    // The status code only: a model's error text can echo what it was sent.
    const status = /status (\d+)/.exec(String(err))?.[1];
    outOfCredit = status === "402";
    outcome = status ? `model error ${status}` : `error: ${String(err).split("\n")[0]!.slice(0, 80)}`;
  } finally {
    clearTimeout(timer);
  }
  const seconds = (performance.now() - started) / 1000;
  if (out) await computer.screenshot().then((png) => writeFileSync(join(out, `${layout.replaceAll("/", "_")}.png`), png)).catch(() => undefined);
  await computer.close();
  if (outOfCredit) throw new OutOfCredit();
  const saved = await readDraft(draft, token);
  const missed = PERSON.filter((f) => saved?.[f.name] !== f.value).map((f) => f.name);
  return { layout, model: model.label, outcome, correct: PERSON.length - missed.length, missed, seconds, steps };
}

function rowLine(r: Row): string {
  const fields = `${r.correct}/${PERSON.length}`.padEnd(6);
  return `${r.layout.padEnd(30)} ${fields} ${r.seconds.toFixed(1).padStart(7)}s ${String(r.steps).padStart(5)}  ${r.model.padEnd(20)} ${r.outcome.padEnd(12)} ${r.missed.join(",")}`;
}

describe.skipIf(!PORTAL)("fills on layouts it has never seen", () => {
  it(
    "prints correct fields, wall time, steps and model per layout",
    async () => {
      const token = process.env["SANDBOX_PORTAL_DRAFT_TOKEN"];
      if (!token) throw new Error("set SANDBOX_PORTAL_DRAFT_TOKEN to the portal's draft token");
      const model = modelFromEnv();
      // Before any model call: this has to be our test portal, with its layouts.
      const index = await fetch(`${PORTAL}/layouts`);
      if (!index.ok || !(await index.text()).includes("TEST SYSTEM")) throw new Error(`${PORTAL} is not the sandbox portal with its layouts`);

      const asked = Number(process.env["MEASURE_SCRAMBLES"] ?? MAX_SCRAMBLES);
      const count = Math.min(Number.isInteger(asked) && asked >= 0 ? asked : MAX_SCRAMBLES, MAX_SCRAMBLES);
      const given = (process.env["MEASURE_SEEDS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const seeds = given.length > 0 ? given.slice(0, MAX_SCRAMBLES) : Array.from({ length: count }, () => randomBytes(4).toString("hex"));
      const layouts = [...FIXED_LAYOUTS.map((id) => `/v/${id}`), ...seeds.map((seed) => `/scramble/${seed}`)];
      const out = process.env["MEASURE_OUT"];
      if (out) mkdirSync(out, { recursive: true });

      if (!model.client) console.log("STAND-IN RUN: it reads the page's HTML instead of the screen. These rows prove the plumbing and measure no model.");
      console.log(`${"layout".padEnd(30)} ${"fields".padEnd(6)} ${"wall".padStart(8)} ${"steps".padStart(5)}  ${"model".padEnd(20)} ${"outcome".padEnd(12)} missed`);
      const rows: Row[] = [];
      let stopped = false;
      for (const layout of layouts) {
        try {
          const row = await fillOne(layout, model, token, out);
          rows.push(row);
          console.log(rowLine(row));
        } catch (err) {
          if (!(err instanceof OutOfCredit)) throw err;
          stopped = true;
          console.log(`Stopped at ${layout}: the model answered 402, so it and the layouts after it were not run.`);
          break;
        }
      }

      const correct = rows.reduce((sum, r) => sum + r.correct, 0);
      const whole = rows.filter((r) => r.correct === PERSON.length);
      const inBudget = whole.filter((r) => r.steps <= AGENT_STEPS && r.seconds * 1000 <= AGENT_MS);
      const seconds = rows.map((r) => r.seconds).sort((a, b) => a - b);
      const median = seconds.length > 0 ? `${seconds[Math.floor(seconds.length / 2)]!.toFixed(1)}s` : "none";
      console.log(`Layouts run: ${rows.length} of ${layouts.length}${stopped ? " (stopped early)" : ""}. Fully correct: ${whole.length}. Fields correct: ${correct} of ${rows.length * PERSON.length}. Median wall: ${median}.`);
      console.log(`Fully correct within the agent's current limits of ${AGENT_STEPS} steps and ${AGENT_MS / 1000}s: ${inBudget.length}. This run allowed ${MAX_STEPS} steps and ${LAYOUT_DEADLINE_MS / 1000}s.`);
      if (seeds.length > 0) console.log(`Seeds: ${seeds.join(",")}`);
      if (out) writeFileSync(join(out, "results.json"), JSON.stringify({ portal: PORTAL, seeds, rows }, null, 2));
    },
    (LAYOUT_DEADLINE_MS + 20_000) * (FIXED_LAYOUTS.length + MAX_SCRAMBLES),
  );
});
