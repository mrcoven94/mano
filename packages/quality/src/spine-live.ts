// spine:live: drives Maria's renewal against a deployed Mano, the way the
// text line does: signed turns to the agent, and the photo stored in Engine
// first. Every run uses a new random handle and the synthetic letter in
// spine-letter.jpg. It files on the sandbox portal only, and nothing is
// stubbed: a step passes only on what the deployment answered.
// The command line is bin/spine-live.ts.

import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { DEFAULT_GUARDIAN_MODEL } from "@mano/guardian";
import { mintHandleGrant, personIdForHandle } from "../../protocol/src/handle-grant.ts";

export const STEPS = ["health", "text", "guardian", "photo", "deadline", "fill", "yes", "portal"] as const;
export type StepName = (typeof STEPS)[number];
export type Lang = "en" | "es";

export interface StepReport {
  step: StepName;
  ok: boolean;
  wallMs: number;
  // The Meta model behind the step, as the deployment reported it. Null for
  // a step no model takes part in.
  model: string | null;
  http: number | null;
  attempts: number;
  detail: string;
  // Mano's words with links removed, since a replay link is a key.
  reply?: string;
}

export interface LiveRun {
  handle: string;
  lang: Lang;
  yesWord: string;
  startedAt: string;
  wallMs: number;
  ok: boolean;
  failedStep: StepName | null;
  confirmation: string | null;
  steps: StepReport[];
}

export interface LiveConfig {
  agentUrl: string;
  engineUrl: string;
  portalUrl: string;
  agentSecret: string;
  grantSecret: string;
  engineChannelsToken: string;
  engineAgentToken: string;
  portalToken: string;
  lang: Lang;
  yesWord?: string;
  // Keep going to YES after a fill with no replay behind it, to see the rest
  // of the path. The run still fails.
  pastFill?: boolean;
  fetchImpl?: typeof fetch;
  // Asks the deployed Guardian whether its model is loaded. Only "ready"
  // passes: Engine's /health says Guardian is set, not that it can answer.
  warmGuardian: () => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  onStep?: (step: StepReport) => void;
}

// The env names the driver needs, in LiveConfig's order.
export const REQUIRED_ENV = [
  "MANO_AGENT_URL",
  "MANO_ENGINE_URL",
  "MANO_PORTAL_URL",
  "MANO_AGENT_SECRET",
  "MANO_HANDLE_GRANT_SECRET",
  "MANO_ENGINE_CHANNELS_TOKEN",
  "MANO_ENGINE_AGENT_TOKEN",
  "SANDBOX_PORTAL_TOKEN",
  "MANO_GUARDIAN_URL",
  "MANO_GUARDIAN_TOKEN",
  "MANO_GUARDIAN_KEY_ID",
  "MANO_GUARDIAN_KEY_SECRET",
] as const;

const letter = (): Buffer => readFileSync(new URL("./spine-letter.jpg", import.meta.url));

// What spine-letter.jpg says.
const LETTER_DUE = "2026-11-14";
const LETTER_DUE_WORDS: Record<Lang, RegExp> = { en: /\bNovember 14, 2026\b/i, es: /\b14 de noviembre de 2026\b|\bNovember 14, 2026\b/i };
// The replay page's own words for a draft still waiting for the yes.
const REPLAY_WAITING = "This is exactly what Mano will send when you reply YES.";

const MARIA = {
  caseNumber: "R-1042",
  fullName: "Maria Torres",
  dateOfBirth: "1988-04-12",
  householdSize: "2",
  monthlyIncome: "1940",
  address: "418 Alder St Apt 3, Springfield, IL 62701",
  phone: "(555) 010-0187",
};

const NOT_ALPHANUMERIC = /[^a-z0-9]/g;
const AMOUNT_PUNCTUATION = /[$,\s]/g;
const FILED_ROW = /<td class="label">([^<]*)<\/td><td>(.*?)<\/td>/g;
const HTML_TAG = /<[^>]*>/g;
const LETTER_RUN = /\p{L}+/gu;
const LINK_IN_TEXT = /https?:\/\/\S+/g;
const WHITESPACE_RUN = /\s+/g;
const REPLAY_LINK = /https?:\/\/\S+\/fill\/[0-9a-f]{32}/;
const REPLAY_SCREEN = /<img src="data:image\/png;base64,/g;
const SAFETY_CHECK_WAIT = /safety check is taking a moment/i;
const STILL_CHECKING = /checking/i;
const CONFIRMATION = /Confirma(?:tion|ción) ([^\s.]+)/;
const SIMULATED_FILING = /simulated filing/i;

// What the portal must hold, by the label on its caseworker page. Punctuation
// and case may differ, as in an address written with or without its comma; an
// amount is compared as a number.
const same = (a: string, b: string): boolean => a.toLowerCase().replace(NOT_ALPHANUMERIC, "") === b.toLowerCase().replace(NOT_ALPHANUMERIC, "");
const FILED: { label: string; expected: string; matches(value: string): boolean }[] = [
  { label: "Case number", expected: MARIA.caseNumber, matches: (v) => same(v, MARIA.caseNumber) },
  { label: "Applicant", expected: MARIA.fullName, matches: (v) => same(v, MARIA.fullName) },
  { label: "Date of birth", expected: MARIA.dateOfBirth, matches: (v) => same(v, MARIA.dateOfBirth) },
  { label: "Address", expected: MARIA.address, matches: (v) => same(v, MARIA.address) },
  { label: "Phone", expected: MARIA.phone, matches: (v) => same(v, MARIA.phone) },
  { label: "Household size", expected: MARIA.householdSize, matches: (v) => v.trim() === MARIA.householdSize },
  { label: "Monthly income", expected: `$${MARIA.monthlyIncome}`, matches: (v) => Number(v.replace(AMOUNT_PUNCTUATION, "")) === Number(MARIA.monthlyIncome) },
  { label: "Declaration", expected: "made by the applicant", matches: (v) => v.startsWith("Made by the applicant") },
];

// The label and value rows of the portal's caseworker page.
export function filedRows(page: string): Map<string, string> {
  return new Map([...page.matchAll(FILED_ROW)].map((m) => [m[1]!, m[2]!.replace(HTML_TAG, "")]));
}

const WORDS: Record<Lang, { opening: string; fill: string; yes: string; answers: [RegExp, string][] }> = {
  en: {
    opening: "My food benefits are ending. Can you help?",
    fill: `Please fill out my renewal now. Case number ${MARIA.caseNumber}. Full legal name ${MARIA.fullName}. Date of birth ${MARIA.dateOfBirth}. ${MARIA.householdSize} people in my household. We earn $${MARIA.monthlyIncome} a month before taxes. Mailing address ${MARIA.address}. Phone ${MARIA.phone}.`,
    yes: "YES",
    answers: [
      [/case number/i, MARIA.caseNumber],
      [/legal name/i, MARIA.fullName],
      [/date of birth/i, MARIA.dateOfBirth],
      [/how many people/i, MARIA.householdSize],
      [/earn|income/i, `$${MARIA.monthlyIncome} a month`],
      [/mailing address/i, MARIA.address],
      [/phone/i, MARIA.phone],
    ],
  },
  es: {
    opening: "Mis beneficios de comida se van a terminar. ¿Me puedes ayudar?",
    fill: `Por favor llena mi renovación ahora. Número de caso ${MARIA.caseNumber}. Nombre legal completo ${MARIA.fullName}. Fecha de nacimiento ${MARIA.dateOfBirth}. Somos ${MARIA.householdSize} personas en mi hogar. Ganamos $${MARIA.monthlyIncome} al mes antes de impuestos. Dirección postal ${MARIA.address}. Teléfono ${MARIA.phone}.`,
    yes: "sí",
    answers: [
      [/n[uú]mero de caso|case number/i, MARIA.caseNumber],
      [/nombre|legal name/i, MARIA.fullName],
      [/nacimiento|date of birth/i, MARIA.dateOfBirth],
      [/cu[aá]ntas personas|how many people/i, MARIA.householdSize],
      [/ganan|ingreso|earn|income/i, `$${MARIA.monthlyIncome} al mes`],
      [/direcci[oó]n|mailing address/i, MARIA.address],
      [/tel[eé]fono|phone/i, MARIA.phone],
    ],
  },
};

const FILL_ROUNDS = 5;
const YES_ATTEMPTS = 6;
const YES_PAUSE_MS = 30_000;
const GUARDIAN_POLLS = 20;
const GUARDIAN_PAUSE_MS = 15_000;
const TURN_TIMEOUT_MS = 100_000;
const CALL_TIMEOUT_MS = 30_000;

const SPANISH = new Set("el la los las un una de del que y en por para con no es mi tu su se te le lo al como pero más puedo puedes ayudar tus beneficios comida fecha carta renovación hola sí necesito tengo".split(" "));
const ENGLISH = new Set("the a an of that and in for with is my your it to you can help benefits food date letter renewal hello need have will are".split(" "));

// A plain word count, enough to tell which of the two languages a reply is
// in. It does not grade the Spanish.
export function looksSpanish(text: string): boolean {
  const words = text.toLowerCase().match(LETTER_RUN) ?? [];
  const spanish = words.filter((w) => SPANISH.has(w)).length;
  const english = words.filter((w) => ENGLISH.has(w)).length;
  return spanish > english;
}

const withoutLinks = (text: string): string => text.replace(LINK_IN_TEXT, "[link]");

class StepFailure extends Error {
  readonly http: number | null;
  readonly reply: string | undefined;

  constructor(message: string, http: number | null = null, reply?: string) {
    super(message);
    this.http = http;
    this.reply = reply;
  }
}

interface Turn {
  http: number;
  status: string;
  text: string;
  reason?: string;
  approval?: string;
  approvalId?: string;
  model?: string;
}

class Person {
  readonly handleHash = createHash("sha256").update(`spine-live-${randomBytes(32).toString("hex")}`).digest("hex");
  // The model the deployment last named on a turn.
  model: string | null = null;
  private turns = 0;
  private docs = 0;
  private readonly cfg: LiveConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: LiveConfig) {
    this.cfg = cfg;
    this.fetchImpl = cfg.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private get personPath(): string {
    return `${this.cfg.engineUrl}/api/persons/${encodeURIComponent(personIdForHandle(this.handleHash))}`;
  }

  private grant(): Promise<string> {
    return mintHandleGrant(this.handleHash, this.cfg.grantSecret);
  }

  private signed(raw: string): Record<string, string> {
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", this.cfg.agentSecret).update(ts).update(".").update(raw).digest("hex");
    return { "content-type": "application/json", "x-mano-timestamp": ts, "x-mano-signature": signature };
  }

  async turn(texts: string[], documents: { id: string; mimeType: string }[] = []): Promise<Turn> {
    this.turns += 1;
    const raw = JSON.stringify({
      turnId: `${this.handleHash}:0:${this.turns}`,
      generation: 0,
      receivedAt: Date.now(),
      handleHash: this.handleHash,
      grant: await this.grant(),
      texts,
      attachmentCount: documents.length,
      documents,
    });
    const res = await this.fetchImpl(`${this.cfg.agentUrl}/channels/mano/turn`, {
      method: "POST",
      signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
      headers: this.signed(raw),
      body: raw,
    });
    const body = await res.text();
    let parsed: Partial<Turn> = {};
    try {
      parsed = JSON.parse(body) as Partial<Turn>;
    } catch {
      parsed = {};
    }
    this.model = parsed.model ?? this.model;
    return { ...parsed, http: res.status, status: parsed.status ?? "not_json", text: parsed.text ?? "" };
  }

  // What Channels reports once a question reached the person word for word.
  async presented(approvalId: string, question: string): Promise<number> {
    const raw = JSON.stringify({
      handleHash: this.handleHash,
      approvalId,
      textHash: createHash("sha256").update(question.replace(WHITESPACE_RUN, " ").trim()).digest("hex"),
      generation: 0,
      grant: await this.grant(),
    });
    const res = await this.fetchImpl(`${this.cfg.agentUrl}/channels/mano/presented`, {
      method: "POST",
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      headers: this.signed(raw),
      body: raw,
    });
    return res.status;
  }

  async uploadLetter(): Promise<{ http: number; document: { id: string; mimeType: string } }> {
    this.docs += 1;
    const id = `spinelive${this.docs}`;
    const bytes = letter();
    const res = await this.fetchImpl(`${this.personPath}/documents`, {
      method: "POST",
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${this.cfg.engineChannelsToken}`,
        "content-type": "application/json",
        "x-mano-handle-grant": await this.grant(),
      },
      body: JSON.stringify({ id, name: `${id}.jpeg`, contentB64: bytes.toString("base64"), generation: 0 }),
    });
    return { http: res.status, document: { id, mimeType: "image/jpeg" } };
  }

  async engineGet(path: string): Promise<{ http: number; json: unknown }> {
    const res = await this.fetchImpl(`${this.personPath}${path}`, {
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      headers: { authorization: `Bearer ${this.cfg.engineAgentToken}`, "x-mano-handle-grant": await this.grant() },
    });
    return { http: res.status, json: await res.json().catch(() => null) };
  }
}

type StepResult = Pick<StepReport, "model" | "http" | "detail"> & Partial<Pick<StepReport, "attempts" | "reply">>;

// A 200 with words, or the step fails with what came back.
function answered(turn: Turn, what: string): Turn {
  if (turn.http !== 200 || !turn.text) {
    throw new StepFailure(`${what}: HTTP ${turn.http}, status ${turn.status}${turn.reason ? `, reason ${turn.reason}` : ""}`, turn.http, withoutLinks(turn.text));
  }
  return turn;
}

// The next thing Maria says when Mano asks instead of preparing the form:
// the answer to the question, or everything again.
function nextAnswer(lang: Lang, question: string): string {
  const words = WORDS[lang];
  return words.answers.find(([asks]) => asks.test(question))?.[1] ?? words.fill;
}

const reported = (turn: Turn): string => turn.model ?? "not reported by this build";

export async function runLive(cfg: LiveConfig): Promise<LiveRun> {
  const person = new Person(cfg);
  const words = WORDS[cfg.lang];
  const yesWord = cfg.yesWord ?? words.yes;
  const sleep = cfg.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const fetchImpl = cfg.fetchImpl ?? ((input, init) => fetch(input, init));
  const started = Date.now();
  let approvalId = "";
  let confirmation: string | null = null;
  let presented = false;

  const steps: Record<StepName, () => Promise<StepResult>> = {
    async health() {
      const res = await fetchImpl(`${cfg.engineUrl}/health`, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; live?: { checker?: string; executor?: string } } | null;
      const detail = `engine ok ${body?.ok}, checker ${body?.live?.checker}, executor ${body?.live?.executor}`;
      if (!res.ok || !body?.ok) throw new StepFailure(detail, res.status);
      if (body.live?.checker !== "guardian") throw new StepFailure(`${detail}: Guardian is not the checker`, res.status);
      if (body.live?.executor !== "sandbox") throw new StepFailure(`${detail}: filings would not reach the sandbox portal`, res.status);
      return { model: null, http: res.status, detail };
    },
    async text() {
      const turn = answered(await person.turn([words.opening]), "the first text got no answer");
      const reply = withoutLinks(turn.text);
      if (cfg.lang === "es" && !looksSpanish(turn.text)) throw new StepFailure("a text in Spanish was answered in English", turn.http, reply);
      return { model: reported(turn), http: turn.http, detail: turn.status, reply };
    },
    async guardian() {
      let state = "";
      for (let attempt = 1; attempt <= GUARDIAN_POLLS; attempt++) {
        state = await cfg.warmGuardian();
        if (state === "ready") return { model: DEFAULT_GUARDIAN_MODEL, http: null, detail: "up", attempts: attempt };
        if (attempt < GUARDIAN_POLLS) await sleep(GUARDIAN_PAUSE_MS);
      }
      throw new StepFailure(`Guardian did not come up: ${state}`);
    },
    async photo() {
      const upload = await person.uploadLetter();
      if (upload.http !== 200 && upload.http !== 201) throw new StepFailure(`Engine refused the photo: HTTP ${upload.http}`, upload.http);
      const turn = answered(await person.turn([], [upload.document]), "the photo got no answer");
      const reply = withoutLinks(turn.text);
      if (!LETTER_DUE_WORDS[cfg.lang].test(turn.text)) throw new StepFailure("the reply does not give the letter's deadline", turn.http, reply);
      if (cfg.lang === "es" && !looksSpanish(turn.text)) throw new StepFailure("the letter's answer to a Spanish conversation is in English", turn.http, reply);
      return { model: reported(turn), http: turn.http, detail: turn.status, reply };
    },
    async deadline() {
      const { http, json } = await person.engineGet("/deadlines");
      const deadlines = ((json as { deadlines?: { dueDate?: string; status?: string }[] } | null)?.deadlines ?? []).filter((d) => d.status !== "done" && d.status !== "cancelled");
      const dates = deadlines.map((d) => d.dueDate).join(", ") || "none";
      if (http !== 200 || deadlines.length !== 1 || deadlines[0]!.dueDate !== LETTER_DUE) {
        throw new StepFailure(`Engine holds: ${dates} (HTTP ${http}), expected only ${LETTER_DUE}`, http);
      }
      return { model: null, http, detail: `Engine holds ${dates}` };
    },
    async fill() {
      let say = words.fill;
      let turn = answered(await person.turn([say]), "the request to fill got no answer");
      const replies = [turn.text];
      let rounds = 1;
      while (turn.status !== "waiting_approval" && rounds < FILL_ROUNDS) {
        say = nextAnswer(cfg.lang, turn.text);
        turn = answered(await person.turn([say]), "an answer to Mano's question got no reply");
        replies.push(turn.text);
        rounds += 1;
      }
      // Every turn's words: an earlier reply can hold why the last one came.
      const reply = withoutLinks(replies.join(" | "));
      if (turn.status !== "waiting_approval" || !turn.approvalId || !turn.approval) {
        throw new StepFailure(`no approval question after ${rounds} turns`, turn.http, reply);
      }
      approvalId = turn.approvalId;
      const shown = await person.presented(approvalId, turn.approval);
      if (shown !== 200) throw new StepFailure(`the presented report answered HTTP ${shown}`, shown, reply);
      presented = true;
      // A question with no replay page was drafted without the computer. The
      // link is opened as the person opens it, with no credentials.
      const link = turn.text.match(REPLAY_LINK)?.[0];
      if (!link?.startsWith(`${cfg.engineUrl}/`)) throw new StepFailure("no replay link in the question, so this draft was not filled on the desktop", turn.http, reply);
      const replay = await fetchImpl(link, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      const page = await replay.text();
      const screens = page.match(REPLAY_SCREEN)?.length ?? 0;
      if (replay.status !== 200 || !page.includes(REPLAY_WAITING) || screens === 0 || !page.includes(MARIA.caseNumber)) {
        throw new StepFailure(`the replay page did not show the fill: HTTP ${replay.status}, ${screens} screens`, replay.status, reply);
      }
      return { model: reported(turn), http: turn.http, detail: `filled, replay page shows ${screens} screens, after ${rounds} turn${rounds === 1 ? "" : "s"}`, attempts: rounds, reply };
    },
    async yes() {
      let turn: Turn | null = null;
      let attempts = 0;
      // Mano tells a person to send YES again while Guardian starts.
      while (attempts < YES_ATTEMPTS) {
        attempts += 1;
        turn = answered(await person.turn([yesWord]), `${yesWord} got no answer`);
        if (!SAFETY_CHECK_WAIT.test(turn.text) && !STILL_CHECKING.test(turn.text)) break;
        if (attempts < YES_ATTEMPTS) await sleep(YES_PAUSE_MS);
      }
      const reply = withoutLinks(turn!.text);
      const number = CONFIRMATION.exec(turn!.text)?.[1];
      if (!number) throw new StepFailure(`${yesWord} did not file`, turn!.http, reply);
      if (SIMULATED_FILING.test(turn!.text)) throw new StepFailure("the filing was simulated", turn!.http, reply);
      const { json } = await person.engineGet("/approvals");
      const list = (json as { approvals?: { id: string; outcome?: { receipt?: { externalId: string; simulated: boolean } | null } }[] } | null)?.approvals ?? [];
      const receipt = list.find((a) => a.id === approvalId)?.outcome?.receipt;
      if (receipt?.externalId !== number || receipt.simulated) throw new StepFailure(`Engine's receipt does not match ${number}`, turn!.http, reply);
      confirmation = number;
      return { model: DEFAULT_GUARDIAN_MODEL, http: turn!.http, detail: `filed, confirmation ${number}`, attempts, reply };
    },
    async portal() {
      const res = await fetchImpl(`${cfg.portalUrl}/caseworker/${encodeURIComponent(confirmation!)}`, {
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        headers: { authorization: `Bearer ${cfg.portalToken}` },
      });
      const rows = filedRows(await res.text());
      if (res.status !== 200 || rows.get("Confirmation") !== confirmation) throw new StepFailure(`the portal has no ${confirmation}: HTTP ${res.status}`, res.status);
      const wrong = FILED.filter((f) => !f.matches(rows.get(f.label) ?? ""));
      if (wrong.length > 0) {
        throw new StepFailure(`the filing is wrong: ${wrong.map((f) => `${f.label} is ${rows.get(f.label) ?? "missing"}, expected ${f.expected}`).join("; ")}`, res.status);
      }
      const file = await fetchImpl(`${cfg.portalUrl}/caseworker/${encodeURIComponent(confirmation!)}/file/0`, {
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        headers: { authorization: `Bearer ${cfg.portalToken}` },
      });
      const filed = Buffer.from(await file.arrayBuffer());
      if (file.status !== 200 || !filed.equals(letter())) {
        throw new StepFailure(`the filed document is not Maria's letter: HTTP ${file.status}, ${filed.length} bytes`, file.status);
      }
      return { model: null, http: res.status, detail: `the portal holds ${confirmation} with every field as Maria gave it and her letter, byte for byte` };
    },
  };

  const reports: StepReport[] = [];
  let failedStep: StepName | null = null;
  for (const step of STEPS) {
    const at = Date.now();
    let report: StepReport;
    try {
      const result = await steps[step]();
      report = { step, ok: true, wallMs: Date.now() - at, attempts: 1, ...result };
    } catch (err) {
      const failure = err instanceof StepFailure ? err : null;
      report = {
        step,
        ok: false,
        wallMs: Date.now() - at,
        model: step === "guardian" || step === "yes" ? DEFAULT_GUARDIAN_MODEL : step === "text" || step === "photo" || step === "fill" ? person.model : null,
        http: failure?.http ?? null,
        attempts: 1,
        detail: failure ? failure.message : `${step} could not finish: ${err instanceof Error ? err.name : "error"}`,
        ...(failure?.reply ? { reply: failure.reply } : {}),
      };
      failedStep ??= step;
    }
    reports.push(report);
    cfg.onStep?.(report);
    const goOn = cfg.pastFill && report.step === "fill" && presented;
    if (!report.ok && !goOn) break;
  }

  return {
    handle: `${person.handleHash.slice(0, 12)}...`,
    lang: cfg.lang,
    yesWord,
    startedAt: new Date(started).toISOString(),
    wallMs: Date.now() - started,
    ok: failedStep === null,
    failedStep,
    confirmation,
    steps: reports,
  };
}
