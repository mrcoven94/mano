// Validation for each page kind. Hand rolled so this package stays
// dependency free. Every check builds a fresh object: unknown fields are
// dropped, never stored. Copy stays in Mano's voice: plain words, no
// dashes, no model names.

import { PAGE_KINDS, type PageKind, type ValidatedPage } from "./types.js";

export interface SchemaError {
  path: string;
  message: string;
}

export type SchemaResult = { ok: true; data: ValidatedPage } | { ok: false; errors: SchemaError[] };

const SHORT = 200;
const LINE = 500;
const LONG = 2000;

function fail(path: string, message: string): SchemaError {
  return { path, message };
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(
  obj: Record<string, unknown>,
  key: string,
  max: number,
  errors: SchemaError[],
  path: string,
): string | null {
  const raw = obj[key];
  if (typeof raw !== "string" || raw.trim() === "") {
    errors.push(fail(path, "needs words"));
    return null;
  }
  if (raw.length > max) {
    errors.push(fail(path, `keep it under ${max} characters`));
    return null;
  }
  return raw;
}

function optionalText(
  obj: Record<string, unknown>,
  key: string,
  max: number,
  errors: SchemaError[],
  path: string,
): string | undefined {
  const raw = obj[key];
  if (raw === undefined) return undefined;
  const out = text(obj, key, max, errors, path);
  return out === null ? undefined : out;
}

function textList(
  obj: Record<string, unknown>,
  key: string,
  max: number,
  maxItems: number,
  minItems: number,
  errors: SchemaError[],
  path: string,
): string[] | null {
  const raw = obj[key];
  if (!Array.isArray(raw)) {
    errors.push(fail(path, "needs a list"));
    return null;
  }
  if (raw.length < minItems || raw.length > maxItems) {
    errors.push(fail(path, `needs between ${minItems} and ${maxItems} entries`));
    return null;
  }
  const out: string[] = [];
  raw.forEach((entry, i) => {
    if (typeof entry !== "string" || entry.trim() === "" || entry.length > max) {
      errors.push(fail(`${path}.${i}`, "needs words"));
      return;
    }
    out.push(entry);
  });
  return errors.length > 0 ? null : out;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function itemId(obj: Record<string, unknown>, errors: SchemaError[], path: string): string | null {
  const raw = obj.id;
  if (typeof raw !== "string" || !ID_PATTERN.test(raw)) {
    errors.push(fail(path, "needs a simple id"));
    return null;
  }
  return raw;
}

function flag(obj: Record<string, unknown>, key: string, errors: SchemaError[], path: string): boolean | null {
  const raw = obj[key];
  if (typeof raw !== "boolean") {
    errors.push(fail(path, "needs yes or no"));
    return null;
  }
  return raw;
}

function money(obj: Record<string, unknown>, key: string, errors: SchemaError[], path: string): number | null {
  const raw = obj[key];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1_000_000_000) {
    errors.push(fail(path, "needs an amount of zero or more"));
    return null;
  }
  return raw;
}

// Action links stay inside Mano or on plain https pages. Anything else,
// including protocol relative urls, is refused.
function actionHref(
  obj: Record<string, unknown>,
  key: string,
  errors: SchemaError[],
  path: string,
): string | undefined {
  const raw = obj[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.length > 500) {
    errors.push(fail(path, "needs a link"));
    return undefined;
  }
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
  try {
    const url = new URL(raw);
    if (url.protocol === "https:") return raw;
  } catch {
    // Falls through to the error below.
  }
  errors.push(fail(path, "links must start with / or https"));
  return undefined;
}

function photoUrl(
  obj: Record<string, unknown>,
  key: string,
  errors: SchemaError[],
  path: string,
): string | undefined {
  const raw = obj[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.length > 2000) {
    errors.push(fail(path, "needs a photo link"));
    return undefined;
  }
  try {
    const url = new URL(raw);
    if (url.protocol === "https:") return raw;
  } catch {
    // Falls through to the error below.
  }
  errors.push(fail(path, "photos must load over https"));
  return undefined;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isoDate(value: unknown, errors: SchemaError[], path: string): string | null {
  if (typeof value !== "string") {
    errors.push(fail(path, "needs a date"));
    return null;
  }
  const match = DATE_PATTERN.exec(value);
  if (!match) {
    errors.push(fail(path, "needs a real calendar date"));
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    errors.push(fail(path, "needs a real calendar date"));
    return null;
  }
  return value;
}

// Builder helpers for tests and callers. They only shape input; nothing is
// trusted until validatePageData runs.
export function estimateData(v: Record<string, unknown>): Record<string, unknown> {
  return v;
}
export function letterData(v: Record<string, unknown>): Record<string, unknown> {
  return v;
}
export function checklistData(v: Record<string, unknown>): Record<string, unknown> {
  return v;
}
export function reviewData(v: Record<string, unknown>): Record<string, unknown> {
  return v;
}
export function approveData(v: Record<string, unknown>): Record<string, unknown> {
  return v;
}

function estimate(obj: Record<string, unknown>, errors: SchemaError[]): ValidatedPage | null {
  const program = text(obj, "program", 40, errors, "program");
  const programLine = text(obj, "programLine", SHORT, errors, "programLine");
  const rangeLow = money(obj, "rangeLow", errors, "rangeLow");
  const rangeHigh = money(obj, "rangeHigh", errors, "rangeHigh");
  const period = text(obj, "period", 40, errors, "period");
  const nextStep = text(obj, "nextStep", LINE, errors, "nextStep");
  const nextHref = actionHref(obj, "nextHref", errors, "nextHref");
  const changes = textList(obj, "changes", LINE, 20, 0, errors, "changes");
  const factsRaw = obj.factsUsed;
  const facts: { label: string; value: string }[] = [];
  if (!Array.isArray(factsRaw) || factsRaw.length < 1 || factsRaw.length > 20) {
    errors.push(fail("factsUsed", "needs between 1 and 20 facts"));
  } else {
    factsRaw.forEach((entry, i) => {
      const rec = recordOf(entry);
      if (!rec) {
        errors.push(fail(`factsUsed.${i}`, "needs a label and a value"));
        return;
      }
      const label = text(rec, "label", SHORT, errors, `factsUsed.${i}.label`);
      const value = text(rec, "value", SHORT, errors, `factsUsed.${i}.value`);
      if (label !== null && value !== null) facts.push({ label, value });
    });
  }
  if (
    errors.length > 0 ||
    program === null ||
    programLine === null ||
    rangeLow === null ||
    rangeHigh === null ||
    period === null ||
    nextStep === null ||
    changes === null
  ) {
    return null;
  }
  if (rangeLow > rangeHigh) {
    errors.push(fail("rangeLow", "the low end cannot top the high end"));
    return null;
  }
  return {
    kind: "estimate",
    program,
    programLine,
    rangeLow,
    rangeHigh,
    period,
    factsUsed: facts,
    changes,
    nextStep,
    ...(nextHref === undefined ? {} : { nextHref }),
  };
}

function letter(obj: Record<string, unknown>, errors: SchemaError[]): ValidatedPage | null {
  const from = text(obj, "from", SHORT, errors, "from");
  const subject = text(obj, "subject", SHORT, errors, "subject");
  const summary = textList(obj, "summary", LONG, 8, 1, errors, "summary");
  const todo = textList(obj, "todo", LINE, 10, 1, errors, "todo");
  const photo = photoUrl(obj, "photoUrl", errors, "photoUrl");
  const photoAlt = optionalText(obj, "photoAlt", SHORT, errors, "photoAlt");
  let deadline: { label: string; date: string } | undefined;
  if (obj.deadline !== undefined) {
    const rec = recordOf(obj.deadline);
    if (!rec) {
      errors.push(fail("deadline", "needs a label and a date"));
    } else {
      const label = text(rec, "label", SHORT, errors, "deadline.label");
      const date = isoDate(rec.date, errors, "deadline.date");
      if (label !== null && date !== null) deadline = { label, date };
    }
  }
  if (errors.length > 0 || from === null || subject === null || summary === null || todo === null) {
    return null;
  }
  return {
    kind: "letter",
    from,
    subject,
    summary,
    todo,
    ...(deadline === undefined ? {} : { deadline }),
    ...(photo === undefined ? {} : { photoUrl: photo }),
    ...(photoAlt === undefined ? {} : { photoAlt }),
  };
}

function checklist(obj: Record<string, unknown>, errors: SchemaError[]): ValidatedPage | null {
  const title = text(obj, "title", SHORT, errors, "title");
  const intro = optionalText(obj, "intro", LONG, errors, "intro");
  const nextStep = optionalText(obj, "nextStep", LINE, errors, "nextStep");
  const nextHref = actionHref(obj, "nextHref", errors, "nextHref");
  const itemsRaw = obj.items;
  const items: { id: string; label: string; detail?: string; checked: boolean }[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(itemsRaw) || itemsRaw.length < 1 || itemsRaw.length > 50) {
    errors.push(fail("items", "needs between 1 and 50 items"));
  } else {
    itemsRaw.forEach((entry, i) => {
      const rec = recordOf(entry);
      if (!rec) {
        errors.push(fail(`items.${i}`, "needs a label"));
        return;
      }
      const id = itemId(rec, errors, `items.${i}.id`);
      const label = text(rec, "label", LINE, errors, `items.${i}.label`);
      const detail = optionalText(rec, "detail", LONG, errors, `items.${i}.detail`);
      const checked = flag(rec, "checked", errors, `items.${i}.checked`);
      if (id !== null) {
        if (seen.has(id)) errors.push(fail(`items.${i}.id`, "ids must differ"));
        seen.add(id);
      }
      if (id !== null && label !== null && checked !== null) {
        items.push({ id, label, checked, ...(detail === undefined ? {} : { detail }) });
      }
    });
  }
  if (errors.length > 0 || title === null) return null;
  return {
    kind: "checklist",
    title,
    items,
    ...(intro === undefined ? {} : { intro }),
    ...(nextStep === undefined ? {} : { nextStep }),
    ...(nextHref === undefined ? {} : { nextHref }),
  };
}

function review(obj: Record<string, unknown>, errors: SchemaError[]): ValidatedPage | null {
  const formName = text(obj, "formName", SHORT, errors, "formName");
  const intro = optionalText(obj, "intro", LONG, errors, "intro");
  const nextStep = optionalText(obj, "nextStep", LINE, errors, "nextStep");
  const nextHref = actionHref(obj, "nextHref", errors, "nextHref");
  const fieldsRaw = obj.fields;
  const fields: { id: string; label: string; value: string; unsure: boolean; note?: string }[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(fieldsRaw) || fieldsRaw.length < 1 || fieldsRaw.length > 100) {
    errors.push(fail("fields", "needs between 1 and 100 fields"));
  } else {
    fieldsRaw.forEach((entry, i) => {
      const rec = recordOf(entry);
      if (!rec) {
        errors.push(fail(`fields.${i}`, "needs a label and a value"));
        return;
      }
      const id = itemId(rec, errors, `fields.${i}.id`);
      const label = text(rec, "label", SHORT, errors, `fields.${i}.label`);
      const rawValue = rec.value;
      let value: string | null = null;
      if (typeof rawValue !== "string" || rawValue.length > LONG) {
        errors.push(fail(`fields.${i}.value`, "keep it under 2000 characters"));
      } else {
        value = rawValue;
      }
      const unsure = flag(rec, "unsure", errors, `fields.${i}.unsure`);
      const note = optionalText(rec, "note", LONG, errors, `fields.${i}.note`);
      if (id !== null) {
        if (seen.has(id)) errors.push(fail(`fields.${i}.id`, "ids must differ"));
        seen.add(id);
      }
      if (id !== null && label !== null && value !== null && unsure !== null) {
        fields.push({ id, label, value, unsure, ...(note === undefined ? {} : { note }) });
      }
    });
  }
  if (errors.length > 0 || formName === null) return null;
  return {
    kind: "review",
    formName,
    fields,
    ...(intro === undefined ? {} : { intro }),
    ...(nextStep === undefined ? {} : { nextStep }),
    ...(nextHref === undefined ? {} : { nextHref }),
  };
}

function approve(obj: Record<string, unknown>, errors: SchemaError[]): ValidatedPage | null {
  const action = text(obj, "action", LINE, errors, "action");
  const forWhom = text(obj, "forWhom", SHORT, errors, "forWhom");
  const destination = text(obj, "destination", SHORT, errors, "destination");
  const note = optionalText(obj, "note", LONG, errors, "note");
  let otpRequired = false;
  if (obj.otpRequired !== undefined) {
    const flagValue = flag(obj, "otpRequired", errors, "otpRequired");
    if (flagValue === null) return null;
    otpRequired = flagValue;
  }
  if (obj.decision !== undefined) {
    errors.push(fail("decision", "only the person can answer"));
    return null;
  }
  const sendsRaw = obj.sends;
  const sends: { label: string; detail?: string }[] = [];
  if (!Array.isArray(sendsRaw) || sendsRaw.length < 1 || sendsRaw.length > 20) {
    errors.push(fail("sends", "needs between 1 and 20 entries"));
  } else {
    sendsRaw.forEach((entry, i) => {
      const rec = recordOf(entry);
      if (!rec) {
        errors.push(fail(`sends.${i}`, "needs a label"));
        return;
      }
      const label = text(rec, "label", LINE, errors, `sends.${i}.label`);
      const detail = optionalText(rec, "detail", LONG, errors, `sends.${i}.detail`);
      if (label !== null) sends.push({ label, ...(detail === undefined ? {} : { detail }) });
    });
  }
  if (errors.length > 0 || action === null || forWhom === null || destination === null) return null;
  return {
    kind: "approve",
    action,
    forWhom,
    destination,
    sends,
    ...(note === undefined ? {} : { note }),
    ...(otpRequired ? { otpRequired: true as const } : {}),
  };
}

export function validatePageData(kind: unknown, data: unknown): SchemaResult {
  if (typeof kind !== "string" || !(PAGE_KINDS as string[]).includes(kind)) {
    return { ok: false, errors: [fail("kind", "pick estimate, letter, checklist, review or approve")] };
  }
  const obj = recordOf(data);
  if (!obj) return { ok: false, errors: [fail("data", "needs an object")] };
  const errors: SchemaError[] = [];
  const pageKind = kind as PageKind;
  const built =
    pageKind === "estimate"
      ? estimate(obj, errors)
      : pageKind === "letter"
        ? letter(obj, errors)
        : pageKind === "checklist"
          ? checklist(obj, errors)
          : pageKind === "review"
            ? review(obj, errors)
            : approve(obj, errors);
  if (!built || errors.length > 0) {
    return { ok: false, errors: errors.length > 0 ? errors : [fail("data", "invalid")] };
  }
  return { ok: true, data: built };
}
