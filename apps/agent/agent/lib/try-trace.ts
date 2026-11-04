// Reports for the judge demo's panel (apps/engine/src/try): each model call on
// a demo run, and each screen of Mano's computer as it arrives. Only a handle
// with the demo's prefix reports anything, so a real person's turn is unchanged
// and sends no report. A report that fails never affects the turn.
import type { Computer, ModelClient as ComputerModel } from "@mano/computer";
import { BudgetExceeded, SEGMENT_MODEL, SegmentationSkipped, type ModelClient as MailModel } from "@mano/mail";
import { isTryHandle, isTryPerson } from "@mano/protocol";

import { BACKUP_ANSWERED, OPEN_WEIGHT_MODEL_ID, selectModelRoute } from "./muse.js";
import type { FillDeps } from "./computer-fill.js";

const REPORT_MS = 8_000;
const MAX_SCREENS = 24;
const TRAILING_SLASH = /\/$/;
const PROVIDER_PREFIX = /^(openrouter|modal|mano)\//;
const META_PREFIX = /^meta\/(?=muse-spark-1|sam-)/;
const META_API_MODEL = /^(muse-|sam-)/;

async function report(body: Record<string, unknown>): Promise<void> {
  const base = process.env.ENGINE_URL;
  const token = process.env.MANO_ENGINE_AGENT_TOKEN;
  if (!base || !token) return;
  try {
    await fetch(`${base.replace(TRAILING_SLASH, "")}/try/report`, {
      method: "POST",
      signal: AbortSignal.timeout(REPORT_MS),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // The panel misses one line; the run goes on.
  }
}

type Call = { model: string; where: string; purpose: string; ms: number; status: string; state: "live" | "skipped" | "stand-in" };

const STAND_IN = { model: "stand-in", where: "No model called", state: "stand-in" } as const;

// Who a call really went to, read from the ID the call itself used. Eve can
// prefix an ID with its provider's name, and the where is never assumed from
// the settings, so a backup route that answers is named as itself.
export function identityOf(raw: string): Pick<Call, "model" | "where" | "state"> {
  const id = raw.replace(PROVIDER_PREFIX, "").replace(META_PREFIX, "");
  if (id.includes("stand-in")) return STAND_IN;
  if (id.startsWith("meta-models/")) return { model: id, where: "Modal", state: "live" };
  if (id === OPEN_WEIGHT_MODEL_ID) return { model: id, where: "OpenRouter, zero retention", state: "live" };
  if (META_API_MODEL.test(id)) return { model: id, where: "Meta's API", state: "live" };
  return { model: id, where: "Not known", state: "live" };
}

const reportCall = (handleHash: string, model: Call): Promise<void> => report({ handleHash, model });

const MODEL_OUTPUT = new Set(["reasoning.appended", "message.appended", "action.input.appended", "actions.requested"]);

interface Marks {
  observe(event: { type: string; meta?: { at?: unknown } }): void;
}

// One line per step of the agent's run, from the times Eve stamps on its
// events and the model it names on each step. A step's model call ends at its
// last output, before its tools run.
export function tryStepTrace(handleHash: string, marks: Marks): Marks & { flush(): Promise<unknown> } {
  if (!isTryHandle(handleHash)) return { observe: (event) => marks.observe(event), flush: async () => undefined };
  const sent: Promise<void>[] = [];
  let started: number | null = null;
  let lastOutput: number | null = null;
  let modelId = "";
  return {
    observe(event) {
      marks.observe(event);
      const at = typeof event.meta?.at === "string" ? Date.parse(event.meta.at) : NaN;
      if (!Number.isFinite(at)) return;
      if (event.type === "step.started") {
        started = at;
        lastOutput = null;
        const named = (event as { data?: { modelId?: unknown } }).data?.modelId;
        modelId = typeof named === "string" ? named : "";
      } else if (started !== null && MODEL_OUTPUT.has(event.type)) {
        lastOutput = at;
      } else if (started !== null && (event.type === "step.completed" || event.type === "step.failed")) {
        const failed = event.type === "step.failed" && lastOutput === null;
        // The step started under Modal's name; the backup marks what it answered.
        const answeredBy = (event as { data?: { providerMetadata?: { gateway?: { generationId?: unknown } } } }).data?.providerMetadata?.gateway?.generationId;
        const identity = identityOf(answeredBy === BACKUP_ANSWERED ? OPEN_WEIGHT_MODEL_ID : modelId || "not named");
        sent.push(reportCall(handleHash, { ...identity, purpose: "Mano's turn", ms: (lastOutput ?? at) - started, status: failed ? "failed" : "ok" }));
        started = null;
      }
    },
    flush: () => Promise.all(sent),
  };
}

// A letter read names who answered in its result. A failed one goes to the
// route this deployment reads on, since the request's ID is only what Mail
// asked for: the open-weight clients answer every read with their own model.
export function tracedMailModel(client: MailModel, handleHash: string): MailModel {
  if (!isTryHandle(handleHash)) return client;
  const purposeOf = (model: string) => (model === SEGMENT_MODEL ? "Finding the letter in the photo" : "Reading the letter");
  return {
    live: client.live,
    async responses(req, opts) {
      const at = Date.now();
      const purpose = purposeOf(req.model);
      const skipped = () => reportCall(handleHash, { model: req.model, where: "Not called", purpose, ms: 0, status: "skipped", state: "skipped" });
      if (!client.live) {
        try {
          return await client.responses(req, opts);
        } finally {
          await reportCall(handleHash, { ...STAND_IN, purpose, ms: Date.now() - at, status: "no model" });
        }
      }
      try {
        const result = await client.responses(req, opts);
        await reportCall(handleHash, { ...identityOf(result.model), purpose, ms: Date.now() - at, status: "ok" });
        return result;
      } catch (err) {
        if (err instanceof SegmentationSkipped || err instanceof BudgetExceeded) await skipped();
        else {
          const route = selectModelRoute();
          await reportCall(handleHash, { ...identityOf(route.name === "meta" ? req.model : route.modelId), purpose, ms: Date.now() - at, status: "failed" });
        }
        throw err;
      }
    },
  };
}

// A fill has 60 seconds, so reporting a screen never holds it up. Closing the
// computer waits for what is still on its way.
function tracedComputer(inner: Computer, handleHash: string, sending: Promise<void>[]): Computer {
  let reported = 0;
  let last: Uint8Array | null = null;
  return {
    async screenshot() {
      const png = await inner.screenshot();
      const same = last !== null && last.length === png.length && Buffer.compare(last, png) === 0;
      if (!same && reported < MAX_SCREENS) {
        last = png;
        reported += 1;
        sending.push(report({ handleHash, screenB64: Buffer.from(png).toString("base64") }));
      }
      return png;
    },
    act: (actions) => inner.act(actions),
    goto: (url) => inner.goto(url),
    stageFile: (name, data) => inner.stageFile(name, data),
    fileUploadHint: () => inner.fileUploadHint(),
    liveViewUrl: () => inner.liveViewUrl(),
    close: async () => {
      await Promise.all(sending);
      await inner.close();
    },
  };
}

export function tracedFillDeps<T extends FillDeps | { unavailable: string }>(deps: T, personId: string): T {
  if ("unavailable" in deps || !isTryPerson(personId)) return deps;
  const handleHash = personId.slice("handle-".length);
  const inner: ComputerModel = deps.model;
  const purpose = "Mano's computer";
  const sending: Promise<void>[] = [];
  const model: ComputerModel = {
    async createResponse(request) {
      const at = Date.now();
      try {
        const response = await inner.createResponse(request);
        // The raw reply names the model that answered, when the host says.
        const named = (response as { model?: unknown }).model;
        sending.push(reportCall(handleHash, { ...identityOf(typeof named === "string" && named ? named : request.model), purpose, ms: Date.now() - at, status: response.status }));
        return response;
      } catch (err) {
        sending.push(reportCall(handleHash, { ...identityOf(request.model), purpose, ms: Date.now() - at, status: "failed" }));
        throw err;
      }
    },
  };
  return { ...deps, model, computer: tracedComputer(deps.computer, handleHash, sending) };
}
