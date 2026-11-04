// Reports for the judge demo's panel (apps/engine/src/try): each model call on
// a demo run, and each screen of Mano's computer as it arrives. Only a handle
// with the demo's prefix reports anything, so a real person's turn is unchanged
// and sends no report. A report that fails never affects the turn.
import type { Computer, ModelClient as ComputerModel } from "@mano/computer";
import type { ModelClient as MailModel } from "@mano/mail";
import { isTryHandle, isTryPerson } from "@mano/protocol";

import { OPEN_WEIGHT_MODEL_ID, selectModelRoute } from "./muse.js";
import type { FillDeps } from "./computer-fill.js";

const REPORT_MS = 3_000;
const MAX_SCREENS = 24;

async function report(body: Record<string, unknown>): Promise<void> {
  const base = process.env.ENGINE_URL;
  const token = process.env.MANO_ENGINE_AGENT_TOKEN;
  if (!base || !token) return;
  try {
    await fetch(`${base.replace(/\/$/, "")}/try/report`, {
      method: "POST",
      signal: AbortSignal.timeout(REPORT_MS),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // The panel misses one line; the run goes on.
  }
}

const whereOf = (modelId: string): string => (modelId === OPEN_WEIGHT_MODEL_ID ? "OpenRouter, zero retention" : "Meta's API");

function reportModel(handleHash: string, model: string, purpose: string, ms: number, status: string): Promise<void> {
  return report({ handleHash, model: { model, where: whereOf(model), purpose, ms, status } });
}

const MODEL_OUTPUT = new Set(["reasoning.appended", "message.appended", "action.input.appended", "actions.requested"]);

interface Marks {
  observe(event: { type: string; meta?: { at?: unknown } }): void;
}

// One line per step of the agent's run, from the times Eve stamps on its
// events. A step's model call ends at its last output, before its tools run.
export function tryStepTrace(handleHash: string, marks: Marks): Marks & { flush(): Promise<unknown> } {
  if (!isTryHandle(handleHash)) return { observe: (event) => marks.observe(event), flush: async () => undefined };
  // A deployment with no key answers with the stand-in, and the panel says so.
  const route = selectModelRoute();
  const model = route.apiKey ? route.modelId : "stand-in, no model called";
  const sent: Promise<void>[] = [];
  let started: number | null = null;
  let lastOutput: number | null = null;
  return {
    observe(event) {
      marks.observe(event);
      const at = typeof event.meta?.at === "string" ? Date.parse(event.meta.at) : NaN;
      if (!Number.isFinite(at)) return;
      if (event.type === "step.started") {
        started = at;
        lastOutput = null;
      } else if (started !== null && MODEL_OUTPUT.has(event.type)) {
        lastOutput = at;
      } else if (started !== null && (event.type === "step.completed" || event.type === "step.failed")) {
        const failed = event.type === "step.failed" && lastOutput === null;
        sent.push(reportModel(handleHash, model, "Mano's turn", (lastOutput ?? at) - started, failed ? "failed" : "ok"));
        started = null;
      }
    },
    flush: () => Promise.all(sent),
  };
}

export function tracedMailModel(client: MailModel, handleHash: string): MailModel {
  if (!isTryHandle(handleHash)) return client;
  return {
    live: client.live,
    async responses(req, opts) {
      const at = Date.now();
      try {
        const result = await client.responses(req, opts);
        await reportModel(handleHash, req.model, "Reading the letter", Date.now() - at, "ok");
        return result;
      } catch (err) {
        await reportModel(handleHash, req.model, "Reading the letter", Date.now() - at, "failed");
        throw err;
      }
    },
  };
}

function tracedComputer(inner: Computer, handleHash: string): Computer {
  let reported = 0;
  let last: Uint8Array | null = null;
  return {
    async screenshot() {
      const png = await inner.screenshot();
      const same = last !== null && last.length === png.length && Buffer.compare(last, png) === 0;
      if (!same && reported < MAX_SCREENS) {
        last = png;
        reported += 1;
        await report({ handleHash, screenB64: Buffer.from(png).toString("base64") });
      }
      return png;
    },
    act: (actions) => inner.act(actions),
    goto: (url) => inner.goto(url),
    stageFile: (name, data) => inner.stageFile(name, data),
    fileUploadHint: () => inner.fileUploadHint(),
    liveViewUrl: () => inner.liveViewUrl(),
    close: () => inner.close(),
  };
}

export function tracedFillDeps<T extends FillDeps | { unavailable: string }>(deps: T, personId: string): T {
  if ("unavailable" in deps || !isTryPerson(personId)) return deps;
  const handleHash = personId.slice("handle-".length);
  const inner: ComputerModel = deps.model;
  const model: ComputerModel = {
    async createResponse(request) {
      const at = Date.now();
      try {
        const response = await inner.createResponse(request);
        await reportModel(handleHash, request.model, "Mano's computer", Date.now() - at, response.status);
        return response;
      } catch (err) {
        await reportModel(handleHash, request.model, "Mano's computer", Date.now() - at, "failed");
        throw err;
      }
    },
  };
  return { ...deps, model, computer: tracedComputer(deps.computer, handleHash) };
}
