import type { ComputerAction, SafetyCheck } from "./actions";
import type { Computer } from "./computer";
import { runLoop } from "./loop";
import type { ModelClient } from "./model";

export interface HouseholdFields {
  fullName: string;
  dateOfBirth: string;
  address: string;
  phone: string;
  householdSize: string;
  monthlyIncome: string;
}

export interface ExecuteFile {
  name: string;
  type: string;
  data: Uint8Array;
}

export interface ExecuteRequest {
  /** Sandbox portal base URL, for example https://sandbox.withmano.com. */
  portalUrl: string;
  household: HouseholdFields;
  files: ExecuteFile[];
  model?: string;
  maxSteps?: number;
  onSafetyCheck?: (check: SafetyCheck) => Promise<boolean>;
  onCredentialsNeeded?: (liveViewUrl: string | null) => Promise<void>;
  onTurn?: (turn: { step: number; call: ComputerAction[] } | { step: number; message: string }) => void;
}

export type ExecuteOutcome = "filed" | "duplicate" | "infeasible" | "failed";

export interface ExecuteResult {
  outcome: ExecuteOutcome;
  key?: string;
  confirmationNumber?: string;
  digest?: string;
  message: string;
  steps: number;
}

export interface SubmissionStatus {
  status: "received" | "retired" | "not_found";
  confirmationNumber?: string;
  digest?: string;
}

/** A filing as the caseworker record shows it. Global across scopes. */
export interface CaseRecord {
  confirmationNumber: string;
  key: string;
  applicant: string;
  receivedAt: number;
}

export interface ExecutorOptions {
  model: string;
  /** Bearer token for the portal JSON API. */
  portalToken?: string;
  fetchImpl?: typeof fetch;
}

/** Clock slack for matching a record to its run. */
const CLOCK_MARGIN_MS = 5 * 60 * 1000;

/**
 * Files a renewal through the computer and reconciles through the portal API.
 * The computer is always stopped at the end of execute, win or lose.
 */
export class Executor {
  private fetchImpl: typeof fetch;

  constructor(
    private computer: Computer,
    private model: ModelClient,
    private options: ExecutorOptions,
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async execute(request: ExecuteRequest): Promise<ExecuteResult> {
    const startedAt = Date.now();
    try {
      const staged: string[] = [];
      for (const file of request.files) staged.push(await this.computer.stageFile(file.name, file.data));
      const portal = request.portalUrl.replace(/\/$/, "");
      await this.computer.goto(`${portal}/apply`);
      const outcome = await runLoop(this.computer, this.model, taskText(request, staged, this.computer.fileUploadHint()), {
        model: request.model ?? this.options.model,
        ...(request.maxSteps !== undefined ? { maxSteps: request.maxSteps } : {}),
        onSafetyCheck: request.onSafetyCheck ?? defaultSafetyPolicy,
        ...(request.onCredentialsNeeded ? { onCredentialsNeeded: request.onCredentialsNeeded } : {}),
        ...(request.onTurn ? { onTurn: request.onTurn } : {}),
      });
      if (outcome.status !== "done") {
        const message = outcome.status === "infeasible" ? outcome.message : outcomeMessage(outcome);
        return { outcome: outcome.status === "infeasible" ? "infeasible" : "failed", message, steps: outcome.steps };
      }
      const report = parseReport(outcome.message);
      if (!report) return { outcome: "failed", message: outcome.message, steps: outcome.steps };
      const reconciled = await this.reconcile(portal, request, report, startedAt);
      if (!reconciled) {
        return { outcome: "failed", message: `reconcile mismatch for key ${report.key}`, steps: outcome.steps, key: report.key };
      }
      const filed: ExecuteResult = {
        outcome: report.duplicate ? "duplicate" : "filed",
        key: reconciled.key,
        confirmationNumber: reconciled.confirmationNumber,
        message: outcome.message,
        steps: outcome.steps,
      };
      if (reconciled.digest !== undefined) filed.digest = reconciled.digest;
      return filed;
    } finally {
      await this.computer.close();
    }
  }

  /**
   * Reconcile a run report. API filings answer through the key; browser
   * filings live in web scope, invisible to the token API, so they answer
   * through the caseworker record for the reported confirmation. A 32-hex
   * key is easy to misread, so a key mismatch still passes when the record
   * names this run's applicant and arrived during this run.
   */
  private async reconcile(
    portal: string,
    request: ExecuteRequest,
    report: { key: string; confirmation: string; digest?: string },
    startedAt: number,
  ): Promise<{ key: string; confirmationNumber: string; digest?: string } | null> {
    const status = await this.check(portal, report.key);
    if (status.status !== "not_found") {
      if (status.confirmationNumber !== report.confirmation) return null;
      if (report.digest !== undefined && status.digest !== report.digest) return null;
      if (status.confirmationNumber === undefined) return null;
      const ok: { key: string; confirmationNumber: string; digest?: string } = { key: report.key, confirmationNumber: status.confirmationNumber };
      if (status.digest !== undefined) ok.digest = status.digest;
      return ok;
    }
    const record = await this.checkConfirmation(portal, report.confirmation);
    if (!record) return null;
    if (record.key !== report.key) {
      const fresh = record.receivedAt >= startedAt - CLOCK_MARGIN_MS && record.receivedAt <= Date.now() + CLOCK_MARGIN_MS;
      if (record.applicant !== request.household.fullName || !fresh) return null;
    }
    const ok: { key: string; confirmationNumber: string; digest?: string } = { key: record.key, confirmationNumber: record.confirmationNumber };
    if (report.digest !== undefined) ok.digest = report.digest;
    return ok;
  }

  /** Look up the caseworker record for a confirmation number. Null when absent. */
  async checkConfirmation(portalUrl: string, confirmation: string): Promise<CaseRecord | null> {
    const headers: Record<string, string> = {};
    if (this.options.portalToken) headers["authorization"] = `Bearer ${this.options.portalToken}`;
    const res = await this.fetchImpl(`${portalUrl.replace(/\/$/, "")}/caseworker/${encodeURIComponent(confirmation)}`, { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`caseworker lookup failed with status ${res.status}`);
    const html = await res.text();
    const conf = /<span class="conf">([^<]+)<\//.exec(html)?.[1];
    const key = /<span class="key">([^<]+)<\//.exec(html)?.[1];
    const applicant = /Applicant<\/td><td>([^<]*)<\//.exec(html)?.[1];
    const received = /Received<\/td><td>([^<]+) via [a-z]+<\//.exec(html)?.[1];
    const receivedAt = received ? Date.parse(received) : Number.NaN;
    if (!conf || !key || applicant === undefined || Number.isNaN(receivedAt)) throw new Error("caseworker page changed shape; cannot reconcile");
    return { confirmationNumber: conf, key, applicant, receivedAt };
  }

  /** Reconcile through GET /submissions/:key. Never files. */
  async check(portalUrl: string, key: string): Promise<SubmissionStatus> {
    const headers: Record<string, string> = {};
    if (this.options.portalToken) headers["authorization"] = `Bearer ${this.options.portalToken}`;
    const res = await this.fetchImpl(`${portalUrl.replace(/\/$/, "")}/submissions/${encodeURIComponent(key)}`, { headers });
    if (res.status === 404) return { status: "not_found" };
    if (!res.ok) throw new Error(`reconcile failed with status ${res.status}`);
    const body = (await res.json()) as { status?: unknown; confirmationNumber?: unknown; digest?: unknown; retired?: unknown };
    if (body.status !== "received") return { status: "not_found" };
    const out: SubmissionStatus = { status: body.retired === true ? "retired" : "received" };
    if (typeof body.confirmationNumber === "string") out.confirmationNumber = body.confirmationNumber;
    if (typeof body.digest === "string") out.digest = body.digest;
    return out;
  }
}

function taskText(request: ExecuteRequest, staged: string[], uploadHint: string): string {
  const lines = [
    "File a benefits renewal on the portal now open in this browser.",
    "Steps: fill the household form, attach the documents, review, and submit.",
    `Household (type exactly): ${JSON.stringify(request.household)}`,
    "Dates in the household data are YYYY-MM-DD; type them as MM/DD/YYYY.",
    "For date fields, click the field, press Ctrl+A to select all, type the date, then press Tab.",
    staged.length > 0 ? `Files to attach: ${staged.join(", ")}. ${uploadHint}` : "No files to attach.",
    "The review page shows a submission key and a packet digest; read both carefully.",
    "After submitting, the confirmation page shows a confirmation number; read it carefully.",
    "The moment a confirmation page appears, stop acting and reply with exactly one line and nothing else:",
    "KEY=<submission key> CONFIRMATION=<confirmation number>",
    "Append DIGEST=<packet digest> if you still have the digest from the review page.",
    "Start the line with DUPLICATE if the page says the key already arrived.",
  ];
  return lines.join("\n");
}

function parseReport(message: string): { key: string; confirmation: string; digest?: string; duplicate: boolean } | null {
  const match = /^(DUPLICATE )?KEY=(\S+) CONFIRMATION=(\S+)(?: DIGEST=([0-9a-f]{64}))?/m.exec(message.trim());
  if (!match?.[2] || !match[3]) return null;
  const report: { key: string; confirmation: string; digest?: string; duplicate: boolean } = {
    duplicate: match[1] !== undefined,
    key: match[2],
    confirmation: match[3],
  };
  if (match[4] !== undefined) report.digest = match[4];
  return report;
}

/**
 * Default safety policy. The blanket per-action confirmation is acknowledged:
 * running the batch through this harness is the confirmation. Any other code
 * stops the run unless the caller approves it.
 */
async function defaultSafetyPolicy(check: SafetyCheck): Promise<boolean> {
  return check.code === "computer_action_requires_confirmation";
}

function outcomeMessage(outcome: { status: string; steps: number }): string {
  if (outcome.status === "infeasible") return "the computer could not complete the filing";
  if (outcome.status === "safety_declined") return "a safety check was declined";
  return "the step budget ran out";
}
