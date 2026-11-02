// fill_form for turn tests: a model that types back exactly the values
// its task lists, then reports the form accepted them, and a desktop
// whose form saves what was typed as the draft it was opened with, which
// the portal stand-in answers on GET /drafts/<id>. The person's answers
// carry every field; the profile carries only the proof document, the way
// Profile's contract links an income amount to the pay stub it was read
// from.
import { vi } from "vitest";

import type { Computer, ModelClient, ResponseRequest } from "@mano/computer";

import { FORMS } from "../agent/lib/forms.js";
import { setFillDepsForTests } from "../agent/tools/fill_form.js";
import type { EngineDouble } from "./engine-double.js";

export const PORTAL = "http://portal.test";
const PROOF_ID = "doc-proof";
const at = "2026-10-30T12:00:00.000Z";
const FIELDS = FORMS["food-renewal"]!.fields.map((f) => f.name);

const drafts = new Map<string, Record<string, string>>();

function desktop(): Computer {
  let draft: string | null = null;
  return {
    screenshot: async () => new Uint8Array([137, 80, 78, 71]),
    act: async (actions) => {
      const typed = actions.flatMap((a) => (a.type === "type" ? [a.text.trim()] : []));
      if (!draft || typed.length === 0) return;
      const saved = Object.fromEntries(FIELDS.map((name, i) => [name, typed[i] ?? ""]));
      saved.dateOfBirth = saved.dateOfBirth!.replace(/^(\d{2})\/(\d{2})\/(\d{4})$/, "$3-$1-$2");
      drafts.set(draft, saved);
    },
    goto: async (url) => {
      draft = new URL(url).searchParams.get("draft");
    },
    stageFile: async (name) => `/uploads/${name}`,
    fileUploadHint: () => "",
    liveViewUrl: () => null,
    close: async () => undefined,
  };
}

const portalFetch: typeof fetch = async (input) => {
  const id = /\/drafts\/([0-9a-f]+)$/.exec(String(input))?.[1] ?? "";
  const household = drafts.get(id);
  return household ? Response.json({ id, household, savedAt: 0 }) : Response.json({ id, status: "not_found" }, { status: 404 });
};

const typist: ModelClient = {
  async createResponse(request: ResponseRequest) {
    const first = request.input.length === 1;
    if (!first) return { id: "r2", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ACCEPTED" }] }] };
    const task = ((request.input[0] as { content: { text?: string }[] }).content[0].text ?? "").split("\n");
    const values = task.slice(1).filter((l) => /^[^:]+: /.test(l) && !/^(Type|A long|When|If) /.test(l));
    const actions = values.map((l) => ({ type: "type", text: l.slice(l.indexOf(": ") + 2) }));
    return { id: "r1", status: "completed", output: [{ type: "computer_call", id: "c1", call_id: "call-1", actions, pending_safety_checks: [], status: "completed" }] };
  },
};

export function installFillDouble(engine: EngineDouble): void {
  vi.stubEnv("MANO_PORTAL_URL", PORTAL);
  drafts.clear();
  engine.documents.set(PROOF_ID, "%PDF-1.4 synthetic pay stub");
  engine.profile = {
    person: {},
    household: [],
    income: [{ id: "i1", amount: { value: 1800, source: "document", documentId: PROOF_ID, updatedAt: at }, frequency: { value: "monthly", source: "person", updatedAt: at } }],
    programs: [],
  };
  setFillDepsForTests(() => ({ computer: desktop(), model: typist, modelId: "muse-spark-1.3-contributor", deadlineMs: 5000, draftToken: "test-draft-token", portalFetch }));
}

export function uninstallFillDouble(): void {
  setFillDepsForTests(null);
}
