// The renewal's first step under other layouts, so a fill can be measured on
// screens it has never seen. Every layout posts the same fields to the same
// handler and saves the same draft; only the wording, order, page flow and look
// change. Five are fixed (/v/<id>/apply) and the rest come from a seed
// (/scramble/<seed>/apply): the same seed always gives the same layout. Every
// agency here is invented and every page carries the test banner.
import { escapeHtml } from "./pages";
import type { Household } from "./store";

export type HouseholdField = keyof Household;
export type Flow = "long" | "wizard" | "accordion";

export interface Section {
  title: string;
  fields: HouseholdField[];
}

export interface Theme {
  background: string;
  surface: string;
  ink: string;
  accent: string;
  accentInk: string;
  font: string;
  radius: number;
  width: number;
  fields: "stacked" | "side" | "grid";
  buttons: "left" | "center" | "right";
}

export interface PortalLayout {
  id: string;
  agency: string;
  intro: string;
  flow: Flow;
  /** Between them the sections hold every household field once, in the order the page asks. */
  sections: Section[];
  labels: Record<HouseholdField, string>;
  nextLabel: string;
  backLabel: string;
  submitLabel: string;
  css: string;
}

/** A layout and the address it is served under. */
export interface Mount {
  prefix: string;
  layout: PortalLayout;
  /** The portal path behind the prefix. Null at the bare address, which goes to the form. */
  rest: string | null;
}

function cssFor(t: Theme): string {
  const fields = {
    stacked: `.field { display: block; margin: 0 0 22px 0; } .field label { display: block; margin: 0 0 6px 0; font-weight: 600; } .field input { width: 100%; }`,
    side: `.field { display: flex; gap: 16px; align-items: center; margin: 0 0 14px 0; } .field label { flex: 0 0 42%; } .field input { flex: 1; min-width: 0; }`,
    grid: `.section-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 16px 24px; } .field label { display: block; margin: 0 0 4px 0; font-size: 13px; } .field input { width: 100%; }`,
  }[t.fields];
  return `
  * { box-sizing: border-box; }
  body { background: ${t.background}; color: ${t.ink}; font-family: ${t.font}; font-size: 15px; line-height: 1.45; margin: 0; }
  .banner { background: #cc0000; color: #fff; font: bold 13px Verdana, Arial, sans-serif; text-align: center; padding: 6px; }
  .wrap { max-width: ${t.width}px; margin: 20px auto; padding: 0 16px; }
  .masthead { padding: 16px 0; }
  .masthead h1 { font-size: 24px; margin: 0; color: ${t.accent}; }
  .masthead p { font-size: 13px; margin: 4px 0 0 0; }
  .body { background: ${t.surface}; border-radius: ${t.radius}px; padding: 24px; }
  h2 { font-size: 17px; margin: 0 0 14px 0; }
  input[type=text], input[type=tel], input[type=date] { font: inherit; color: ${t.ink}; background: ${t.background}; border: 1px solid ${t.ink}; border-radius: ${t.radius}px; padding: 8px; }
  fieldset { border: 0; margin: 0; padding: 0; }
  .section { margin: 0 0 22px 0; }
  details { margin: 0 0 12px 0; border: 1px solid ${t.ink}; border-radius: ${t.radius}px; padding: 12px 16px; }
  summary { cursor: pointer; font-weight: 600; }
  details .section-fields { margin-top: 14px; }
  ${fields}
  .actions { display: flex; gap: 12px; justify-content: ${{ left: "flex-start", center: "center", right: "flex-end" }[t.buttons]}; margin-top: 18px; }
  .btn { background: ${t.accent}; color: ${t.accentInk}; border: 0; border-radius: ${t.radius}px; font: inherit; font-weight: 600; padding: 10px 22px; cursor: pointer; }
  .btn.quiet { background: transparent; color: ${t.ink}; border: 1px solid ${t.ink}; }
  .error { border: 2px solid #cc0000; padding: 10px; margin: 0 0 16px 0; }
  .notice { border: 1px solid ${t.ink}; padding: 10px; margin: 0 0 16px 0; }
  .steps { font-size: 13px; margin: 0 0 12px 0; }
  table.form { border-collapse: collapse; width: 100%; }
  table.form td { border-bottom: 1px solid ${t.ink}; padding: 8px; vertical-align: top; }
  table.form td.label { width: 42%; font-weight: 600; }
  .footer { font-size: 12px; padding: 16px 0; }
  .key { font-family: monospace; word-break: break-all; }
  a { color: ${t.accent}; }
`;
}

const SANS = "'Helvetica Neue', Helvetica, Arial, sans-serif";

const FIXED: PortalLayout[] = [
  {
    id: "larkmoor",
    agency: "Larkmoor Family Aid Office",
    intro: "Keep your help going for another year.",
    flow: "long",
    sections: [
      { title: "About you", fields: ["fullName", "dateOfBirth", "phone", "address"] },
      { title: "Your letter", fields: ["caseNumber"] },
      { title: "Your household", fields: ["householdSize", "monthlyIncome"] },
    ],
    labels: {
      fullName: "Your name, as it appears on your ID",
      dateOfBirth: "When were you born?",
      phone: "Best number to reach you",
      address: "Where should we send your mail?",
      caseNumber: "Reference number at the top of your letter",
      householdSize: "How many people live with you, counting yourself?",
      monthlyIncome: "What does your household earn in a month, before taxes?",
    },
    nextLabel: "Next",
    backLabel: "Back",
    submitLabel: "Save and keep going",
    css: cssFor({ background: "#f3f7f1", surface: "#ffffff", ink: "#1d2b20", accent: "#1f6b3a", accentInk: "#ffffff", font: SANS, radius: 8, width: 640, fields: "stacked", buttons: "left" }),
  },
  {
    id: "quillhaven",
    agency: "Quillhaven Department of Household Supports",
    intro: "Annual review of your supports.",
    flow: "wizard",
    sections: [
      { title: "Your file", fields: ["caseNumber", "fullName", "dateOfBirth"] },
      { title: "Staying in touch", fields: ["phone", "address"] },
      { title: "Household and money", fields: ["householdSize", "monthlyIncome"] },
    ],
    labels: {
      caseNumber: "File ID",
      fullName: "Applicant",
      dateOfBirth: "Birth date",
      phone: "Contact phone",
      address: "Home or mailing address",
      householdSize: "Household members",
      monthlyIncome: "Gross monthly household income in dollars",
    },
    nextLabel: "Next",
    backLabel: "Previous",
    submitLabel: "Finish this part",
    css: cssFor({ background: "#e9eef8", surface: "#ffffff", ink: "#16233f", accent: "#1d4ed8", accentInk: "#ffffff", font: "Verdana, Geneva, sans-serif", radius: 12, width: 720, fields: "stacked", buttons: "right" }),
  },
  {
    id: "tern-valley",
    agency: "Tern Valley Community Benefits Desk",
    intro: "Open each section below and answer what it asks.",
    flow: "accordion",
    sections: [
      { title: "Money and household", fields: ["monthlyIncome", "householdSize"] },
      { title: "The person applying", fields: ["fullName", "dateOfBirth", "phone"] },
      { title: "Where we write to you", fields: ["address"] },
      { title: "Your renewal notice", fields: ["caseNumber"] },
    ],
    labels: {
      monthlyIncome: "Total income per month (USD)",
      householdSize: "Number of household members",
      fullName: "Head of household",
      dateOfBirth: "Head of household's date of birth",
      phone: "Daytime telephone",
      address: "Postal address",
      caseNumber: "Renewal ID",
    },
    nextLabel: "Next",
    backLabel: "Back",
    submitLabel: "Send to the next page",
    css: cssFor({ background: "#fbf3e6", surface: "#fffaf1", ink: "#3a2a17", accent: "#a2470f", accentInk: "#ffffff", font: "Georgia, 'Times New Roman', serif", radius: 2, width: 820, fields: "side", buttons: "center" }),
  },
  {
    id: "northbrine",
    agency: "Northbrine Social Assistance Agency",
    intro: "Recertification, form NB-12.",
    flow: "wizard",
    sections: [
      { title: "Recipient", fields: ["fullName", "dateOfBirth"] },
      { title: "Assistance unit", fields: ["householdSize", "monthlyIncome"] },
      { title: "Contact", fields: ["phone", "address"] },
      { title: "Notice", fields: ["caseNumber"] },
    ],
    labels: {
      fullName: "Name of recipient",
      dateOfBirth: "Recipient DOB",
      householdSize: "Persons in the assistance unit",
      monthlyIncome: "Earned and unearned income, monthly",
      phone: "Telephone of record",
      address: "Address of record",
      caseNumber: "Notice control number",
    },
    nextLabel: "Proceed",
    backLabel: "Return",
    submitLabel: "Record and proceed",
    css: cssFor({ background: "#14181f", surface: "#1e2530", ink: "#e6ebf2", accent: "#f2b84b", accentInk: "#14181f", font: "'Courier New', Courier, monospace", radius: 0, width: 680, fields: "side", buttons: "left" }),
  },
  {
    id: "brambleford",
    agency: "Brambleford Assistance Commission",
    intro: "Complete all items. Items may not appear in the order of your notice.",
    flow: "long",
    sections: [
      { title: "Schedule A", fields: ["monthlyIncome", "householdSize", "phone", "fullName", "caseNumber", "address", "dateOfBirth"] },
    ],
    labels: {
      monthlyIncome: "Item 1. Income, all sources, per month",
      householdSize: "Item 2. Size of household",
      phone: "Item 3. Phone",
      fullName: "Item 4. Applicant name in full",
      caseNumber: "Item 5. Case or reference no.",
      address: "Item 6. Address for correspondence",
      dateOfBirth: "Item 7. Date of birth",
    },
    nextLabel: "Next",
    backLabel: "Back",
    submitLabel: "Accept schedule",
    css: cssFor({ background: "#efefe8", surface: "#fafaf5", ink: "#222222", accent: "#5b2a6e", accentInk: "#ffffff", font: "'Times New Roman', Times, serif", radius: 0, width: 960, fields: "grid", buttons: "right" }),
  },
];

const FIXED_BY_ID = new Map(FIXED.map((l) => [l.id, l]));

export const FIXED_LAYOUTS: ReadonlyArray<Pick<PortalLayout, "id" | "agency" | "flow">> = FIXED;

const LABEL_POOL: Record<HouseholdField, string[]> = {
  caseNumber: ["Case ID", "Renewal reference", "Number on your notice", "Application control number", "Client file number", "Your letter's reference number"],
  fullName: ["Name", "Applicant's full name", "Who is renewing?", "Primary applicant", "First and last name", "Name of person applying"],
  dateOfBirth: ["Born on", "DOB", "Your birthday, with year", "Applicant's date of birth", "Birth date", "Date you were born"],
  address: ["Street address and city", "Where do you get mail?", "Residence", "Address for letters", "Home address", "Current mailing location"],
  phone: ["Phone", "Mobile or home phone", "Call-back number", "A number we can reach you at", "Telephone", "Contact number"],
  householdSize: ["Household count", "How many people are in your home?", "Total people in the household, including you", "Family size", "Members of your household", "People you live and share meals with"],
  monthlyIncome: ["Income each month, in dollars", "Household earnings per month", "Monthly gross pay and other income", "How much money comes in each month?", "Total monthly income", "Dollars earned per month, whole household"],
};
const SECTION_POOL = ["Part A", "Part B", "Part C", "Part D", "Your details", "A few questions", "More information", "Almost done"];
const AGENCY_FIRST = ["Fennmark", "Oakhollow", "Wrenford", "Stillbrook", "Marrowgate", "Cindervale", "Thistlecombe", "Hollowmere", "Pellbridge", "Dunmarrow"];
const AGENCY_LAST = ["Household Support Office", "Benefits Renewal Bureau", "Family Services Agency", "Assistance Desk", "Department of Community Aid", "Public Help Commission"];
const INTROS = ["Renew your help here.", "Answer every question below.", "Yearly check of your household.", "Please complete this form."];
const NEXT_POOL = ["Next", "Continue", "Go on", "Next part"];
const BACK_POOL = ["Back", "Previous", "Go back"];
const SUBMIT_POOL = ["Save and continue", "Next page", "Done with this part", "Proceed", "Keep going"];
const FONT_POOL = [SANS, "Verdana, Geneva, sans-serif", "Georgia, serif", "'Times New Roman', Times, serif", "'Trebuchet MS', sans-serif", "'Courier New', monospace"];
const FLOWS: Flow[] = ["long", "wizard", "accordion"];
const FIELD_LAYOUTS: Theme["fields"][] = ["stacked", "side", "grid"];
const BUTTON_ROWS: Theme["buttons"][] = ["left", "center", "right"];
const FIELD_ORDER: HouseholdField[] = ["caseNumber", "fullName", "dateOfBirth", "address", "phone", "householdSize", "monthlyIncome"];

function seededRandom(seed: string): () => number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619);
  let state = hash >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The layout a seed gives, the same one every time. */
export function layoutFromSeed(seed: string): PortalLayout {
  const random = seededRandom(seed);
  const pick = <T>(from: readonly T[]): T => from[Math.floor(random() * from.length)]!;
  const shuffled = <T>(from: readonly T[]): T[] => {
    const out = [...from];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };
  const flow = pick(FLOWS);
  const order = shuffled(FIELD_ORDER);
  const count = flow === "long" ? 1 + Math.floor(random() * 3) : 2 + Math.floor(random() * 3);
  const titles = shuffled(SECTION_POOL);
  const sections: Section[] = Array.from({ length: count }, (_, i) => ({
    title: titles[i]!,
    fields: order.slice(Math.floor((i * order.length) / count), Math.floor(((i + 1) * order.length) / count)),
  }));
  const labels = Object.fromEntries(FIELD_ORDER.map((field) => [field, pick(LABEL_POOL[field])])) as Record<HouseholdField, string>;
  const hue = Math.floor(random() * 360);
  const dark = random() < 0.25;
  const theme: Theme = {
    background: dark ? `hsl(${hue} 25% 11%)` : `hsl(${hue} 35% 94%)`,
    surface: dark ? `hsl(${hue} 22% 17%)` : "#ffffff",
    ink: dark ? `hsl(${hue} 20% 92%)` : `hsl(${hue} 35% 14%)`,
    accent: dark ? `hsl(${hue} 70% 72%)` : `hsl(${hue} 65% 30%)`,
    accentInk: dark ? `hsl(${hue} 30% 10%)` : "#ffffff",
    font: pick(FONT_POOL),
    radius: pick([0, 3, 8, 14]),
    width: pick([620, 720, 840, 960]),
    fields: pick(FIELD_LAYOUTS),
    buttons: pick(BUTTON_ROWS),
  };
  return {
    id: `scramble-${seed}`,
    agency: `${pick(AGENCY_FIRST)} ${pick(AGENCY_LAST)}`,
    intro: pick(INTROS),
    flow,
    sections,
    labels,
    nextLabel: pick(NEXT_POOL),
    backLabel: pick(BACK_POOL),
    submitLabel: pick(SUBMIT_POOL),
    css: cssFor(theme),
  };
}

const SEED = /^[A-Za-z0-9-]{1,32}$/;
const MOUNTED = /^\/(?:v\/([a-z-]+)|scramble\/([A-Za-z0-9-]{1,32}))(\/apply(?:\/.*)?|\/drafts\/.*)?$/;

/**
 * The layout a path asks for. Only the application pages and draft reads exist
 * under a layout: the office's filing and staff routes do not, so a layout can
 * never reach them.
 */
export function mountFromPath(path: string): Mount | undefined {
  const match = MOUNTED.exec(path);
  if (!match) return undefined;
  const [, id, seed, rest] = match;
  const layout = id ? FIXED_BY_ID.get(id) : layoutFromSeed(seed!);
  if (!layout) return undefined;
  return { prefix: id ? `/v/${id}` : `/scramble/${seed}`, layout, rest: rest ?? null };
}

/** A seed a person typed, or a new one when they left it blank. Null when it cannot be one. */
export function seedFromInput(input: string | null, fresh: () => string): string | null {
  const seed = (input ?? "").trim();
  if (seed === "") return fresh().slice(0, 8);
  return SEED.test(seed) ? seed : null;
}

function fieldHtml(field: HouseholdField, layout: PortalLayout, previous?: Partial<Household>): string {
  const type = field === "dateOfBirth" ? "date" : field === "phone" ? "tel" : "text";
  const value = escapeHtml(previous?.[field] ?? "");
  return `<div class="field"><label for="f-${field}">${escapeHtml(layout.labels[field])}</label><input type="${type}" id="f-${field}" name="${field}" value="${value}"></div>`;
}

function sectionFields(section: Section, layout: PortalLayout, previous?: Partial<Household>): string {
  return `<div class="section-fields">${section.fields.map((f) => fieldHtml(f, layout, previous)).join("")}</div>`;
}

// One form across all the steps: the last step posts every field at once to the
// same handler. Enter moves on instead of posting a half-filled form.
const WIZARD_SCRIPT = `<script>
(function () {
  var steps = Array.prototype.slice.call(document.querySelectorAll('.step'));
  var at = 0;
  function show() { steps.forEach(function (s, i) { s.hidden = i !== at; }); }
  document.addEventListener('click', function (e) {
    var go = e.target.closest && e.target.closest('[data-go]');
    if (!go) return;
    e.preventDefault();
    at += Number(go.getAttribute('data-go'));
    show();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && at < steps.length - 1) { e.preventDefault(); at += 1; show(); }
  });
  show();
})();
</script>`;

function formBody(layout: PortalLayout, hasError: boolean, previous?: Partial<Household>): string {
  const submit = `<button class="btn" type="submit">${escapeHtml(layout.submitLabel)}</button>`;
  if (layout.flow === "long") {
    const sections = layout.sections.map((s) => `<div class="section"><h2>${escapeHtml(s.title)}</h2>${sectionFields(s, layout, previous)}</div>`).join("");
    return `${sections}<div class="actions">${submit}</div>`;
  }
  if (layout.flow === "accordion") {
    const sections = layout.sections
      .map((s, i) => `<details${hasError || i === 0 ? " open" : ""}><summary>${escapeHtml(s.title)}</summary>${sectionFields(s, layout, previous)}</details>`)
      .join("");
    return `${sections}<div class="actions">${submit}</div>`;
  }
  const total = layout.sections.length;
  const steps = layout.sections
    .map((s, i) => {
      const back = i > 0 ? `<button class="btn quiet" type="button" data-go="-1">${escapeHtml(layout.backLabel)}</button>` : "";
      const next = i < total - 1 ? `<button class="btn" type="button" data-go="1">${escapeHtml(layout.nextLabel)}</button>` : submit;
      return `<fieldset class="step"><div class="steps">${i + 1} of ${total}</div><h2>${escapeHtml(s.title)}</h2>${sectionFields(s, layout, previous)}<div class="actions">${back}${next}</div></fieldset>`;
    })
    .join("");
  return `${steps}${WIZARD_SCRIPT}`;
}

/** The body of the first step under a layout. It posts what the plain form posts. */
export function layoutHouseholdBody(mount: Pick<Mount, "prefix" | "layout">, draftId: string | null, error?: string, previous?: Partial<Household>): string {
  const err = error ? `<div class="error"><b>Error:</b> ${escapeHtml(error)}</div>` : "";
  return `${err}<form method="post" action="${escapeHtml(mount.prefix)}/apply/household">
${draftId ? `<input type="hidden" name="draft" value="${escapeHtml(draftId)}">` : ""}
${formBody(mount.layout, !!error, previous)}
</form>`;
}

export function layoutsIndexBody(): string {
  const rows = FIXED.map(
    (l) => `<tr><td class="label"><a href="/v/${escapeHtml(l.id)}/apply">${escapeHtml(l.agency)}</a></td><td>${{ long: "One long page", wizard: "Several steps", accordion: "Sections that open" }[l.flow]}</td></tr>`,
  ).join("");
  return `<div class="notice">The same renewal under other layouts. Every agency here is invented.</div>
<table class="form">${rows}</table>
<form method="get" action="/scramble" style="margin-top:14px;">
<label for="seed">Seed for a generated layout (letters, numbers and dashes; leave blank for a new one)</label><br>
<input type="text" id="seed" name="seed" maxlength="32">
<button class="btn" type="submit">Open layout</button>
</form>`;
}
