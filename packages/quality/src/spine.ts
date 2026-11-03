// The judge run: Maria's renewal end to end on one machine, with only the
// judge's own META_MODEL_API_KEY. Maria texts a photo of a synthetic
// renewal letter; Mail reads it (SAM 3.1 finds the letter, Muse Spark 1.3
// reads it); Mano answers with the deadline and drafts the renewal from her
// profile and the letter; Mano's computer fills the form on the sandbox
// portal; Engine's action gateway checks the action with Guardian; Maria
// says yes; the portal receives the filing; Engine's replay page shows
// each step of the fill.
//
// Each step is made of parts, and each part says whether it ran for real
// (a live Meta model call, or Mano's own code) or was simulated (a recorded
// model response, or a local stand-in for a service that needs Mano's
// accounts) and which Meta model it is. The code that runs is the product's
// own: readMail and answerReading from packages/mail, the agent's form
// table and approval question, Engine's action gateway, Guardian checker,
// sandbox executor and replay page, and the sandbox portal's request
// handler on its in-memory store. Simulated, always: Guardian (Muse Glimmer
// runs on Mano's own GPU, so its verdict is recorded), Mano's computer
// (Muse Spark 1.3 driving a hosted desktop on Mano's Modal account; the
// stand-in posts the same values to the portal's form and draws each
// screen), and Maria's YES (she is synthetic). With a key, SAM 3.1 and
// Muse Spark 1.3 run live on Meta's API; a call that fails says why and
// the step falls back to its recording in spine-replay.json, written for
// this letter. Without a key every model step uses its recording.
// Run: pnpm judge (pnpm --filter @mano/quality judge [--out <dir>]).

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import {
  DEFAULT_BASE_URL,
  MetaModelClient,
  RecordedModelClient,
  SEGMENT_MODEL,
  answerReading,
  readMail,
  readingModelFor,
  recordedText,
  type CallOptions,
  type MailAnswer,
  type MailReading,
  type ModelClient,
  type ResponsesRequest,
  type ResponsesResult,
} from "@mano/mail";
import { DEFAULT_GUARDIAN_MODEL } from "@mano/guardian";
import { ActionGateway, MapDocumentStore, MemoryApprovalStore } from "../../../apps/engine/src/gateway/gateway.ts";
import { LocalRulesChecker } from "../../../apps/engine/src/gateway/checker.ts";
import { GuardianChecker } from "../../../apps/engine/src/gateway/guardian.ts";
import { SandboxExecutor } from "../../../apps/engine/src/gateway/executors.ts";
import type { ActionRequest, Approval } from "../../../apps/engine/src/gateway/types.ts";
import { renderReplayPage } from "../../../apps/engine/src/fill-replay.ts";
import { DEFAULT_CONFIG, handleRequest } from "../../../apps/sandbox-portal/src/app.ts";
import { MemoryFileStore, MemoryStore } from "../../../apps/sandbox-portal/test/memory-store.ts";
import { FORMS, fillFrom } from "../../../apps/agent/agent/lib/forms.ts";
import { ATTACHMENT, renderQuestion } from "../../../apps/agent/agent/lib/pending.ts";
import type { Profile } from "../../../apps/agent/agent/lib/engine.ts";

// One piece of a step. real: it ran in this run, as a live Meta model call
// or as Mano's own code. simulated: a recording or a stand-in took its place.
export interface Part {
  ran: "real" | "simulated";
  what: string;
  // The Meta model this part is, or null for plain code.
  model: string | null;
}

export interface StepReport {
  label: string;
  parts: Part[];
  lines: string[];
  // Why the step did not do its job; later steps do not run.
  failure: string | null;
}

export interface SpineRun {
  steps: StepReport[];
  // Live model calls that failed and fell back to their recordings.
  liveFailures: string[];
  // Steps in the spine, run or not.
  total: number;
  files: { letter: string; replay: string | null; filing: string | null };
  ms: number;
}

const MODEL_NAMES: Record<string, string> = {
  [SEGMENT_MODEL]: "SAM 3.1",
  "muse-spark-1.3": "Muse Spark 1.3",
  "muse-spark-1.3-contributor": "Muse Spark 1.3",
  [DEFAULT_GUARDIAN_MODEL]: "Muse Glimmer 30B",
};

function modelName(id: string): string {
  return `${MODEL_NAMES[id] ?? id} (${id})`;
}

interface Recordings {
  segment: unknown;
  read: unknown;
  guardian: { recipient: string; verdict: "pass" | "fix" | "block"; problems: string[] };
}

function loadRecordings(): Recordings {
  return JSON.parse(readFileSync(new URL("./spine-replay.json", import.meta.url), "utf8")) as Recordings;
}

// Answers each Meta model call live when a key is set, else from its
// recording. A live call that fails is kept with why, and that model stays
// on its recording for the rest of the run. Each recording answers once, so
// a call the run did not expect fails instead of replaying a wrong answer.
class LiveOrRecorded implements ModelClient {
  readonly live: boolean;
  // Per model ID: null when it answered live, else why its recording answered.
  private outcome = new Map<string, string | null>();
  // Per model ID: why its live call failed.
  private failed = new Map<string, string>();
  private recorded: RecordedModelClient;

  constructor(private liveClient: ModelClient | null, recordings: Recordings) {
    this.live = liveClient !== null;
    this.recorded = new RecordedModelClient([
      { match: (req) => req.model === SEGMENT_MODEL, consume: true, result: recordedText(JSON.stringify(recordings.segment)) },
      { match: (req) => req.model !== SEGMENT_MODEL, consume: true, result: recordedText(JSON.stringify(recordings.read)) },
    ]);
  }

  async responses(req: ResponsesRequest, opts?: CallOptions): Promise<ResponsesResult> {
    if (this.liveClient && !this.failed.has(req.model)) {
      try {
        const out = await this.liveClient.responses(req, opts);
        this.outcome.set(req.model, null);
        return out;
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        this.failed.set(req.model, why);
        this.outcome.set(req.model, "recorded response, because the live call failed");
      }
    } else if (!this.outcome.has(req.model)) {
      this.outcome.set(req.model, "recorded response; no META_MODEL_API_KEY is set");
    }
    return this.recorded.responses(req, opts);
  }

  get failures(): string[] {
    return [...this.failed].map(([model, why]) => `${modelName(model)}: ${why}`);
  }

  // The line a step prints when this model's live call failed.
  failureLine(model: string): string[] {
    const why = this.failed.get(model);
    return why ? [`! The live ${MODEL_NAMES[model] ?? model} call failed: ${why}. This step used its recorded response.`] : [];
  }

  part(model: string, what: string): Part {
    const why = this.outcome.get(model);
    if (why === null) return { ran: "real", what: `${what}, live on Meta's API`, model };
    return { ran: "simulated", what: `${what}: ${why ?? "not called"}`, model };
  }
}

// Maria Torres is synthetic: her name, address, phone, case and letter are
// made up for the demo.
const PERSON_ID = "maria-torres-synthetic";
const LETTER_ID = "doc-renewal-letter";
const AT = "2026-10-20T15:00:00.000Z";
const said = <T>(value: T) => ({ value, source: "person" as const, updatedAt: AT });

const MARIA_PROFILE: Profile = {
  person: {
    fullName: said("Maria Torres"),
    dateOfBirth: said("1988-04-12"),
    phone: said("(555) 010-0187"),
    address: { line1: said("418 Alder St Apt 3"), city: said("Springfield"), state: said("IL"), zip: said("62701") },
    householdConfirmed: said(true),
  },
  household: [{ id: "member-1", name: said("Sofia Torres"), relationship: said("daughter") }],
  income: [{ id: "income-1", source: said("Greenline Grocers"), amount: said(1940), frequency: said("monthly" as const) }],
  programs: [{ id: "program-1", program: said("SNAP"), state: said("IL"), caseNumber: said("R-1042") }],
};

const LETTER_LINES = [
  "Springfield County Food Assistance Office",
  "Notice date November 2, 2026",
  "",
  "Maria Torres",
  "418 Alder St Apt 3",
  "Springfield, IL 62701",
  "",
  "Re: SNAP renewal",
  "Case R-1042",
  "",
  "Your renewal is due November 14, 2026.",
  "Send the signed renewal form and proof of income.",
  "Late forms stop benefits.",
  "Questions? Call (555) 010-0142.",
  "",
  "This is a synthetic letter made for the Mano demo.",
];

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}

// A phone photo of the letter: the page on a table, slightly turned.
async function letterPhoto(): Promise<Buffer> {
  const text = LETTER_LINES.map((line, i) => `<text x="160" y="${190 + i * 48}">${escapeXml(line)}</text>`).join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1300"><rect width="1000" height="1300" fill="#8a8272"/>` +
    `<g transform="rotate(-1.5 500 650)"><rect x="120" y="80" width="760" height="1140" fill="#fffdf5"/>` +
    `<g font-family="Helvetica, Arial, sans-serif" font-size="27" fill="#1a1a1a">${text}</g></g></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
}

// One screen of the stand-in fill: the portal's household step with the
// first `filled` fields typed in. Returns the PNG and where the last typed
// field sits, for the replay page's close-up.
async function fillScreen(fields: { label: string; value: string }[], filled: number): Promise<{ png: Uint8Array; focus: { x: number; y: number } | null }> {
  const rows = fields
    .map((f, i) => {
      const y = 190 + i * 92;
      const value = i < filled ? escapeXml(f.value) : "";
      return `<text x="80" y="${y}" font-size="22" fill="#222">${escapeXml(f.label)}</text>` +
        `<rect x="420" y="${y - 30}" width="700" height="44" fill="#fff" stroke="#777"/>` +
        `<text x="432" y="${y}" font-size="22" fill="#000">${value}</text>`;
    })
    .join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><rect width="1280" height="800" fill="#e9e6dc"/>` +
    `<rect width="1280" height="70" fill="#2f4a6d"/><g font-family="Helvetica, Arial, sans-serif">` +
    `<text x="80" y="46" font-size="26" fill="#fff">Sandbox Agency Portal: renewal application (test system)</text>` +
    `<text x="80" y="122" font-size="24" fill="#222">Step 1 of 3: household</text>${rows}</g></svg>`;
  const png = new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
  return { png, focus: filled === 0 ? null : { x: 760, y: 190 + (filled - 1) * 92 - 8 } };
}

interface SpineOptions {
  env: NodeJS.ProcessEnv;
  outDir: string;
  print: (line: string) => void;
}

export async function runSpine(opts: SpineOptions): Promise<SpineRun> {
  const started = Date.now();
  const recordings = loadRecordings();
  const key = opts.env.META_MODEL_API_KEY ?? "";
  // Straight to Meta's API, never through an AI Gateway account.
  // MANO_MODEL_BASE_URL points it at another endpoint, for tests.
  const live = key ? new MetaModelClient({ apiKey: key, baseUrl: opts.env.MANO_MODEL_BASE_URL || DEFAULT_BASE_URL, synthetic: true }) : null;
  const model = new LiveOrRecorded(live, recordings);
  const readingModel = readingModelFor(true);

  // The sandbox portal's own code, in this process, with tokens made up
  // for this run. The deployed portal takes filings only with Mano's token.
  const portalToken = randomBytes(24).toString("hex");
  const draftToken = randomBytes(24).toString("hex");
  const portalStore = new MemoryStore();
  const portalFiles = new MemoryFileStore();
  const portalConfig = { ...DEFAULT_CONFIG, portalToken, draftToken };
  const portalOrigin = "http://sandbox-portal.local";
  const portal = ((input: string | URL | Request, init?: RequestInit) =>
    handleRequest(new Request(input, init), portalStore, portalFiles, portalConfig)) as typeof fetch;

  const documents = new MapDocumentStore();
  const executor = new SandboxExecutor(portalOrigin, 15_000, portal, portalToken);
  // Guardian's recorded verdict, for the one action it was recorded for.
  // Any other action gets an error status, which Guardian treats as a block.
  const guardianFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { warm?: boolean; action?: { recipient?: string } };
    if (body.warm === true) return Response.json({ warming: true, ready: true }, { status: 202 });
    if (body.action?.recipient !== recordings.guardian.recipient) return Response.json({ error: "no recorded verdict for this action" }, { status: 500 });
    return Response.json({
      verdict: recordings.guardian.verdict,
      problems: recordings.guardian.problems,
      model: { id: DEFAULT_GUARDIAN_MODEL, revision: "recorded" },
      image: { tag: "recorded", digest: "none" },
    });
  }) as typeof fetch;
  const gateway = new ActionGateway(new MemoryApprovalStore(), executor, {
    checker: new GuardianChecker(new LocalRulesChecker(), { url: "https://guardian.invalid/check", token: "recorded", fetchImpl: guardianFetch }),
    documents,
  });

  const files: SpineRun["files"] = { letter: `${opts.outDir}/letter.jpg`, replay: null, filing: null };
  const form = FORMS["food-renewal"]!;
  const plain = (what: string): Part => ({ ran: "real", what: `${what} (Mano's code, no model)`, model: null });
  const guardianPart: Part = {
    ran: "simulated",
    what: "Guardian's verdict: recorded. Guardian runs Muse Glimmer on Mano's own GPU, which a judge cannot reach",
    model: DEFAULT_GUARDIAN_MODEL,
  };

  let photo: Buffer | null = null;
  let reading: MailReading | null = null;
  let answer: MailAnswer | null = null;
  let request: ActionRequest | null = null;
  let saved: Record<string, string> = {};
  let replaySteps: { caption: string; png: Uint8Array; focus: { x: number; y: number } | null }[] = [];
  let approval: Approval | null = null;
  let confirmation: string | null = null;

  const steps: { label: string; run: () => Promise<Omit<StepReport, "label">> }[] = [
    {
      label: "Maria texts Mano a photo of her renewal letter",
      run: async () => {
        photo = await letterPhoto();
        writeFileSync(files.letter, photo);
        documents.set(LETTER_ID, new Uint8Array(photo));
        return { parts: [plain("Draws the synthetic letter as a phone photo")], lines: [`Photo: ${files.letter}`], failure: null };
      },
    },
    {
      label: "Mail finds the letter in the photo",
      run: async () => {
        reading = await readMail([{ bytes: new Uint8Array(photo!), mimeType: "image/jpeg", name: "letter.jpg" }], { personId: PERSON_ID, synthetic: true, model });
        const fallback = reading.warnings.find((w) => w.kind === "segmentation_fallback");
        return {
          parts: [model.part(SEGMENT_MODEL, "Segments the photo into pages")],
          lines: [...model.failureLine(SEGMENT_MODEL), `Pages found: ${reading.stats.pages}${fallback ? ` (SAM 3.1 boxes not used: ${fallback.message})` : ", from SAM 3.1's boxes"}`],
          failure: reading.stats.pages === 0 ? "no page was found in the photo" : null,
        };
      },
    },
    {
      label: "Mail reads the letter",
      run: async () => {
        const letter = reading!.letters[0];
        const f = letter?.fields;
        return {
          parts: [model.part(readingModel, "Reads the page into cited fields"), plain("Checks every field against the page's own text")],
          lines: f
            ? [...model.failureLine(readingModel), `From: ${f.sender?.value ?? "unknown"}`, `Case: ${f.referenceNo?.value ?? "none"}`, `Deadline sentence: ${f.deadlineText?.value ?? "none"}`]
            : [],
          failure: f ? null : "no letter was read from the page",
        };
      },
    },
    {
      label: "Mano answers with the deadline",
      run: async () => {
        answer = answerReading(reading!);
        const held = answer.deadlines[0];
        return {
          parts: [plain("Builds the reply from the cited fields and the deadline gate")],
          lines: [`Mano: ${answer.text}`, ...(held ? [`Deadline held: ${held.dueDate}`] : [])],
          failure: answer.deadlines.length === 1 ? null : "the reading did not publish exactly one deadline",
        };
      },
    },
    {
      label: "Mano drafts the renewal from Maria's profile and the letter",
      run: async () => {
        const filled = fillFrom(form, MARIA_PROFILE, {});
        const missing = filled.missing && filled.missing.name !== "proof" ? filled.missing : null;
        if (missing) return { parts: [plain("Fills the form table from the profile")], lines: [], failure: `the profile has no ${missing.label}` };
        const held = answer!.deadlines[0]!;
        // As start_form_draft does when no proof of income is on file, the
        // letter Maria just sent is the document attached.
        request = {
          type: "submit",
          recipient: form.recipient,
          purpose: form.purpose,
          payload: { ...filled.values, [ATTACHMENT]: "the photo of your renewal letter" },
          documentId: LETTER_ID,
          idempotencyKey: `judge-${randomBytes(8).toString("hex")}`,
          actor: "foreground",
          personId: PERSON_ID,
          deadlineAt: held.dueDate,
          sources: [{ kind: "document", id: LETTER_ID, quote: held.sentence }],
          origin: "person",
        };
        return {
          parts: [plain("Fills the agent's food-renewal form from the profile, attaches the letter and cites its deadline")],
          lines: [...form.fields.map((f) => `${f.label}: ${filled.values[f.name]}`), `Attached: the letter photo. Due: ${held.dueDate}`],
          failure: null,
        };
      },
    },
    {
      label: "Mano's computer fills the form on the sandbox portal",
      run: async () => {
        const values = request!.payload as Record<string, string>;
        const draftId = randomBytes(16).toString("hex");
        const typed = form.fields.map((f) => ({ label: f.label, value: values[f.name]! }));
        const post = await portal(`${portalOrigin}/apply/household`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ draft: draftId, ...Object.fromEntries(form.fields.map((f) => [f.name, values[f.name]!])) }),
        });
        const read = await portal(`${portalOrigin}/drafts/${draftId}`, { headers: { authorization: `Bearer ${draftToken}` } });
        const draft = read.ok ? ((await read.json()) as { household?: Record<string, string> }).household : undefined;
        saved = draft ?? {};
        const differs = form.fields.filter((f) => saved[f.name] !== values[f.name]).map((f) => f.label);
        replaySteps = [];
        for (let i = 0; i <= typed.length; i++) {
          const screen = await fillScreen(typed, i);
          replaySteps.push({ caption: i === 0 ? "Mano opened the form." : `Mano filled in "${typed[i - 1]!.label}".`, ...screen });
        }
        return {
          parts: [
            {
              ran: "simulated",
              what: "Computer use: a stand-in. Muse Spark 1.3 drives a desktop on Mano's Modal account; the stand-in posts the same values to the portal's form and draws each screen",
              model: "muse-spark-1.3",
            },
            plain("The sandbox portal saves the draft with its own checks, in this process"),
          ],
          lines: [`Portal answered the form with ${post.status}; draft read back with ${read.status}`, `Screens kept for the replay page: ${replaySteps.length}`],
          failure: !draft ? "the portal saved no draft" : differs.length > 0 ? `the portal saved different values for ${differs.join(", ")}` : null,
        };
      },
    },
    {
      label: "Guardian checks the action before Maria is asked",
      run: async () => {
        const result = await gateway.requestAction(request!);
        approval = result.approval ?? null;
        return {
          parts: [plain("Engine's action gateway: policy, local rules, document hash, one approval per key, in this process"), guardianPart],
          lines: approval ? [`Gateway: ${result.status}, approval ${approval.id}`, `Mano asks Maria: ${renderQuestion(approval)}`] : [`Gateway: ${result.status}`],
          failure: result.status === "needs_approval" && approval ? null : `the gateway answered ${result.status}: ${result.reason ?? "no reason"}`,
        };
      },
    },
    {
      label: "Maria says yes and Mano files the renewal",
      run: async () => {
        const result = await gateway.approveAndExecute(approval!.id, PERSON_ID);
        confirmation = result.receipt?.externalId ?? null;
        return {
          parts: [
            { ran: "simulated", what: "Maria's YES: scripted, since Maria is synthetic", model: null },
            plain("Engine checks the exact version again, then its sandbox executor files it"),
            guardianPart,
          ],
          lines: [`Gateway: ${result.status}${confirmation ? `, confirmation ${confirmation}` : ""}${result.reason ? `: ${result.reason}` : ""}`],
          failure: result.status === "completed" && confirmation ? null : `the filing did not complete (${result.status})`,
        };
      },
    },
    {
      label: "The sandbox portal has the filing, and Maria's replay page shows each step",
      run: async () => {
        const found = await executor.check(request!.idempotencyKey, PERSON_ID);
        const detail = await portal(`${portalOrigin}/caseworker/${encodeURIComponent(confirmation!)}`, { headers: { authorization: `Bearer ${portalToken}` } });
        files.filing = `${opts.outDir}/portal-filing.html`;
        writeFileSync(files.filing, await detail.text());
        const steps = await Promise.all(
          replaySteps.map(async (s) => {
            const meta = await sharp(s.png).metadata();
            return { ...s, width: meta.width ?? 1280, height: meta.height ?? 800 };
          }),
        );
        files.replay = `${opts.outDir}/replay.html`;
        writeFileSync(
          files.replay,
          renderReplayPage({
            state: "approved",
            purpose: approval!.purpose,
            recipient: approval!.recipient,
            steps,
            fields: form.fields.map((f) => ({ label: f.label, value: saved[f.name] ?? "" })),
            attached: true,
          }),
        );
        return {
          parts: [plain("The portal's caseworker view and Engine's replay page, rendered by their own code")],
          lines: [`Portal lookup: ${found.found ? `received, ${found.externalId}` : "not found"}`, `Caseworker view: ${files.filing}`, `Replay page: ${files.replay}`],
          failure: found.found && found.externalId === confirmation && detail.ok ? null : "the portal does not show the filing",
        };
      },
    },
  ];

  const reports: StepReport[] = [];
  for (const [i, step] of steps.entries()) {
    opts.print(`[${i + 1}/${steps.length}] ${step.label}`);
    let report: Omit<StepReport, "label">;
    try {
      report = await step.run();
    } catch (err) {
      report = { parts: [], lines: [], failure: err instanceof Error ? err.message : String(err) };
    }
    reports.push({ label: step.label, ...report });
    for (const part of report.parts) {
      opts.print(`      ${part.ran.padEnd(9)}  ${part.what}${part.model ? ` [${modelName(part.model)}]` : ""}`);
    }
    for (const line of report.lines) opts.print(`      ${line}`);
    if (report.failure) {
      opts.print(`      FAILED: ${report.failure}`);
      for (const rest of steps.slice(i + 1)) opts.print(`[not run] ${rest.label}`);
      break;
    }
  }
  return { steps: reports, liveFailures: model.failures, total: steps.length, files, ms: Date.now() - started };
}
