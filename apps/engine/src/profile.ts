// The person's profile: one structured record (who they are, where they
// live, the household, income, programs and case numbers) that every form
// and answer reads, so the person never says the same thing twice.
//
//   GET   /api/persons/:id/profile   { profile }
//   PATCH /api/persons/:id/profile   { idempotencyKey, source, documentId?, fields, generation? }
//
// fields maps a field path to a value, or to null to clear it:
//
//   person.fullName  person.dateOfBirth  person.phone  person.email
//   person.address.line1|line2|city|state|zip  person.county  person.language
//   person.householdConfirmed   (true once the person said who lives with them)
//   household.<id>.name|relationship|dateOfBirth
//   income.<id>.memberId|source|amount|frequency   (memberId: a household id, or "self")
//   programs.<id>.program|state|caseNumber|status
//
// null also clears a whole group: "income", "household.<id>", "person.address".
// source is who the facts came from: "person" (they said it), "document"
// (read from one of their documents, which documentId names) or "agent"
// (Mano moved it from older memory). Every leaf in the answer is
// { value, source, documentId?, updatedAt }.
//
// Trust runs person, then document, then agent. A value from a lower
// source never replaces a different one from a higher source: it is kept
// as a suggestion (GET answers { profile, suggestions }) for the person to
// confirm. Saying it again, from the person, settles the suggestion.
//
// A field moved from a memory note stays linked to it: forgetting either
// one forgets both, and changing the field retires the note.
//
// Each leaf is its own row, sealed with the person's key and bound to its
// path, so a value cannot be read from SQLite or moved to another field.
// The same idempotency key with the same fields answers the same and writes
// nothing; with other fields it is refused. Deleting the person's
// conversation deletes the profile in the same transaction.
import { canonicalJson } from "@mano/protocol";
import { CURRENT_GENERATION } from "./gateway/sql-store.js";
import { sha256Hex } from "./hash.js";

interface SqlExec {
  exec(query: string, ...bindings: unknown[]): { toArray(): unknown[]; rowsWritten: number };
}

export const PROFILE_SOURCES = ["person", "document", "agent"] as const;
export type ProfileSource = (typeof PROFILE_SOURCES)[number];
export const FREQUENCIES = ["weekly", "biweekly", "monthly", "yearly"] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export interface Leaf<T = string> {
  value: T;
  source: ProfileSource;
  documentId?: string;
  updatedAt: string;
}

export interface Profile {
  person: {
    fullName?: Leaf;
    dateOfBirth?: Leaf;
    phone?: Leaf;
    email?: Leaf;
    address: { line1?: Leaf; line2?: Leaf; city?: Leaf; state?: Leaf; zip?: Leaf };
    county?: Leaf;
    language?: Leaf;
    householdConfirmed?: Leaf<boolean>;
  };
  household: { id: string; name?: Leaf; relationship?: Leaf; dateOfBirth?: Leaf }[];
  income: { id: string; memberId?: Leaf; source?: Leaf; amount?: Leaf<number>; frequency?: Leaf<Frequency> }[];
  programs: { id: string; program?: Leaf; state?: Leaf; caseNumber?: Leaf; status?: Leaf }[];
}

type Value = string | number | boolean;
type Kind = "text" | "date" | "phone" | "email" | "state" | "zip" | "amount" | "frequency" | "member" | "flag";

const MAX_TEXT = 200;
const ENTRY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const MAX_FIELDS = 60;

// What each kind of value must look like, normalized. null: not valid.
const NORMALIZE: Record<Kind, (raw: unknown) => Value | null> = {
  text: (raw) => {
    if (typeof raw !== "string") return null;
    const clean = raw.trim().replace(/\s+/g, " ");
    return clean && clean.length <= MAX_TEXT ? clean : null;
  },
  date: (raw) => {
    if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
    const d = new Date(`${raw}T00:00:00Z`);
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === raw ? raw : null;
  },
  phone: (raw) => {
    if (typeof raw !== "string") return null;
    const digits = raw.replace(/\D/g, "");
    return /^[0-9+().\s-]+$/.test(raw.trim()) && digits.length >= 7 && digits.length <= 15 ? raw.trim() : null;
  },
  email: (raw) => (typeof raw === "string" && /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(raw.trim()) ? raw.trim().toLowerCase() : null),
  state: (raw) => (typeof raw === "string" && /^[A-Za-z]{2}$/.test(raw.trim()) ? raw.trim().toUpperCase() : null),
  zip: (raw) => (typeof raw === "string" && /^\d{5}(-\d{4})?$/.test(raw.trim()) ? raw.trim() : null),
  amount: (raw) =>
    typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 10_000_000 ? Math.round(raw * 100) / 100 : null,
  frequency: (raw) => (typeof raw === "string" && (FREQUENCIES as readonly string[]).includes(raw) ? raw : null),
  member: (raw) => (typeof raw === "string" && ENTRY_ID.test(raw) ? raw : null),
  flag: (raw) => (typeof raw === "boolean" ? raw : null),
};

const PERSON_LEAVES: Record<string, Kind> = {
  "person.fullName": "text",
  "person.dateOfBirth": "date",
  "person.phone": "phone",
  "person.email": "email",
  "person.address.line1": "text",
  "person.address.line2": "text",
  "person.address.city": "text",
  "person.address.state": "state",
  "person.address.zip": "zip",
  "person.county": "text",
  "person.language": "text",
  "person.householdConfirmed": "flag",
};

const ENTRY_LEAVES = {
  household: { name: "text", relationship: "text", dateOfBirth: "date" },
  income: { memberId: "member", source: "text", amount: "amount", frequency: "frequency" },
  programs: { program: "text", state: "state", caseNumber: "text", status: "text" },
} as const satisfies Record<string, Record<string, Kind>>;
type Collection = keyof typeof ENTRY_LEAVES;

const GROUPS = new Set(["person", "person.address", ...Object.keys(ENTRY_LEAVES)]);

// A path names one leaf (settable or clearable) or a group (clearable).
type Target = { kind: "leaf"; type: Kind } | { kind: "group" };

function targetOf(path: string): Target | null {
  const personKind = PERSON_LEAVES[path];
  if (personKind) return { kind: "leaf", type: personKind };
  if (GROUPS.has(path)) return { kind: "group" };
  const [collection, id, field, ...rest] = path.split(".");
  const leaves = (ENTRY_LEAVES as Record<string, Record<string, Kind>>)[collection];
  if (!leaves || !id || !ENTRY_ID.test(id) || rest.length > 0) return null;
  if (field === undefined) return { kind: "group" };
  const type = leaves[field];
  return type ? { kind: "leaf", type } : null;
}

export class ProfileInputError extends Error {
  override name = "ProfileInputError";
}

interface ParsedPatch {
  idempotencyKey: string;
  source: ProfileSource;
  documentId: string | null;
  sets: { path: string; value: Value }[];
  clears: string[];
}

export function parseProfilePatch(raw: unknown): ParsedPatch {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ProfileInputError("Body must be a JSON object.");
  const body = raw as Record<string, unknown>;
  if (typeof body.idempotencyKey !== "string" || !KEY.test(body.idempotencyKey)) {
    throw new ProfileInputError("idempotencyKey must be 1 to 128 letters, digits, colons, hyphens or underscores.");
  }
  if (!(PROFILE_SOURCES as readonly unknown[]).includes(body.source)) {
    throw new ProfileInputError(`source must be one of ${PROFILE_SOURCES.join(", ")}.`);
  }
  const source = body.source as ProfileSource;
  const documentId = body.documentId ?? null;
  if (source === "document" && (typeof documentId !== "string" || !documentId)) {
    throw new ProfileInputError("A fact read from a document needs the documentId it was read from.");
  }
  if (source !== "document" && documentId !== null) throw new ProfileInputError("documentId goes only with source document.");
  const fields = body.fields;
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) throw new ProfileInputError("fields must be an object.");
  const entries = Object.entries(fields);
  if (entries.length === 0 || entries.length > MAX_FIELDS) throw new ProfileInputError(`fields must name 1 to ${MAX_FIELDS} paths.`);
  const sets: ParsedPatch["sets"] = [];
  const clears: string[] = [];
  for (const [path, value] of entries) {
    const target = targetOf(path);
    if (!target) throw new ProfileInputError(`${path} is not a profile field.`);
    if (value === null) {
      clears.push(path);
      continue;
    }
    if (target.kind === "group") throw new ProfileInputError(`${path} is a group; set its fields one by one.`);
    const clean = NORMALIZE[target.type](value);
    if (clean === null) throw new ProfileInputError(`${path} is not a valid ${target.type}.`);
    sets.push({ path, value: clean });
  }
  return { idempotencyKey: body.idempotencyKey, source, documentId: documentId as string | null, sets, clears };
}

export interface FieldCipher {
  seal(path: string, plaintext: string): Promise<string>;
  open(path: string, sealed: string): Promise<string>;
}

const TRUST: Record<ProfileSource, number> = { person: 3, document: 2, agent: 1 };
const TRUST_SQL = "(CASE source WHEN 'person' THEN 3 WHEN 'document' THEN 2 ELSE 1 END)";
const UNDER = "(path = ? OR substr(path, 1, ?) = ?)";
const under = (group: string) => [group, group.length + 1, `${group}.`];

export function ensureProfileTables(sql: SqlExec): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS profile_fields(
    path TEXT PRIMARY KEY, sealed TEXT NOT NULL, source TEXT NOT NULL, document_id TEXT, updated_at TEXT NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS profile_patches(
    idempotency_key TEXT PRIMARY KEY, request_hash TEXT NOT NULL, result_json TEXT NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS profile_migrations(name TEXT PRIMARY KEY, at TEXT NOT NULL)`);
  // A lower-trust value that conflicts with a higher-trust one, waiting
  // for the person: one per field and source.
  sql.exec(`CREATE TABLE IF NOT EXISTS profile_suggestions(
    path TEXT NOT NULL, source TEXT NOT NULL, sealed TEXT NOT NULL, document_id TEXT, suggested_at TEXT NOT NULL,
    PRIMARY KEY (path, source))`);
  // Which memory notes a migrated field came from.
  sql.exec(`CREATE TABLE IF NOT EXISTS profile_memory_links(path TEXT NOT NULL, memory_id TEXT NOT NULL, PRIMARY KEY (path, memory_id))`);
}

function hasMemoryTable(sql: SqlExec): boolean {
  return sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory'").toArray().length > 0;
}

// Part of the conversation delete: the profile, its suggestions, links
// and patch keys go. Returns how many fields were removed.
export function clearProfile(sql: SqlExec): number {
  const n = Number((sql.exec("SELECT COUNT(*) AS n FROM profile_fields").toArray()[0] as { n: number }).n);
  for (const table of ["profile_fields", "profile_patches", "profile_suggestions", "profile_memory_links"]) sql.exec(`DELETE FROM ${table}`);
  return n;
}

// Forgetting a memory note also forgets the profile fields moved from it.
export function forgetMemoryNote(sql: SqlExec, memoryId: string): void {
  sql.exec(`DELETE FROM profile_fields WHERE path IN (SELECT path FROM profile_memory_links WHERE memory_id = ?)`, memoryId);
  sql.exec("DELETE FROM profile_memory_links WHERE memory_id = ?", memoryId);
  if (hasMemoryTable(sql)) sql.exec("DELETE FROM memory WHERE id = ?", memoryId);
}

// A field that changes or is cleared retires the notes it came from, so
// the old note never reaches the model beside the new value.
function retireLinkedNotes(sql: SqlExec, path: string, group: boolean): void {
  const where = group ? UNDER : "path = ?";
  const args = group ? under(path) : [path];
  if (hasMemoryTable(sql)) sql.exec(`DELETE FROM memory WHERE id IN (SELECT memory_id FROM profile_memory_links WHERE ${where})`, ...args);
  sql.exec(`DELETE FROM profile_memory_links WHERE ${where}`, ...args);
}

// Older memory notes that say exactly one profile fact. Anything that does
// not match one of these whole, or that two notes disagree on, stays only
// in memory.
const PROGRAMS = "SNAP|WIC|Medicaid|TANF|CHIP|LIHEAP|SSI|SSDI";
const LANGUAGES = "English|Spanish|Vietnamese|Chinese|Mandarin|Cantonese|Arabic|Somali|Russian|Tagalog|Korean|French|Portuguese|Haitian Creole";
const MEMORY_RULES: { pattern: RegExp; fields: (m: RegExpMatchArray) => Record<string, string> }[] = [
  { pattern: /^(?:I )?(?:live|lives|living) in ([A-Z][A-Za-z .'-]* County)\.?$/i, fields: (m) => ({ "person.county": m[1] }) },
  { pattern: /^county(?: is|:) ([A-Z][A-Za-z .'-]* County)\.?$/i, fields: (m) => ({ "person.county": m[1] }) },
  { pattern: new RegExp(`^(?:prefers|speaks|language(?: is|:)) (${LANGUAGES})\\.?$`, "i"), fields: (m) => ({ "person.language": m[1] }) },
  { pattern: /^(?:full )?name is ([A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+)+)\.?$/, fields: (m) => ({ "person.fullName": m[1] }) },
  { pattern: /^(?:born on|date of birth is|birthday is) (\d{4}-\d{2}-\d{2})\.?$/i, fields: (m) => ({ "person.dateOfBirth": m[1] }) },
  { pattern: /^email(?: is|:) (\S+@\S+\.[A-Za-z]{2,})$/i, fields: (m) => ({ "person.email": m[1] }) },
  { pattern: /^phone(?: number)?(?: is|:) ([0-9+().\s-]{7,20})$/i, fields: (m) => ({ "person.phone": m[1] }) },
  { pattern: /^zip(?: code)?(?: is|:) (\d{5})\.?$/i, fields: (m) => ({ "person.address.zip": m[1] }) },
  {
    pattern: new RegExp(`^(${PROGRAMS}) case (?:number|#)(?: is|:) ([A-Za-z0-9-]{3,32})\\.?$`, "i"),
    fields: (m) => {
      const id = m[1].toLowerCase();
      return { [`programs.${id}.program`]: m[1].toUpperCase() === "MEDICAID" ? "Medicaid" : m[1].toUpperCase(), [`programs.${id}.caseNumber`]: m[2] };
    },
  },
];

export interface MigratedField {
  value: Value;
  at: string;
  noteIds: string[];
}

export function profileFieldsFromMemory(notes: { id?: string; content: string; createdAt: string }[]): Map<string, MigratedField> {
  const found = new Map<string, MigratedField>();
  const disputed = new Set<string>();
  for (const note of notes) {
    const text = note.content.trim();
    const rule = MEMORY_RULES.find((r) => r.pattern.test(text));
    if (!rule) continue;
    for (const [path, raw] of Object.entries(rule.fields(text.match(rule.pattern)!))) {
      const target = targetOf(path);
      const value = target?.kind === "leaf" ? NORMALIZE[target.type](raw) : null;
      if (value === null) continue;
      const prior = found.get(path);
      if (prior && prior.value !== value) disputed.add(path);
      else if (prior) prior.noteIds.push(...(note.id ? [note.id] : []));
      else found.set(path, { value, at: note.createdAt, noteIds: note.id ? [note.id] : [] });
    }
  }
  for (const path of disputed) found.delete(path);
  return found;
}

export interface PatchResult {
  changed: string[];
  unchanged: string[];
  cleared: string[];
  // Not applied: a higher-trust value differs. Kept for the person.
  suggested: string[];
  replayed: boolean;
}

export interface Suggestion {
  path: string;
  value: Value;
  source: ProfileSource;
  documentId?: string;
  suggestedAt: string;
}

export type PatchOutcome =
  | { status: "ok"; result: PatchResult }
  | { status: "invalid"; error: string }
  | { status: "conflict" }
  | { status: "stale" };

export interface ProfileStoreDeps {
  sql: SqlExec;
  transaction<T>(fn: () => T): T;
  cipher: FieldCipher;
  now(): Date;
  documentExists(documentId: string): boolean;
}

interface FieldRow {
  path: string;
  sealed: string;
  source: ProfileSource;
  document_id: string | null;
  updated_at: string;
}

const MEMORY_MIGRATION = "memory-to-profile-v1";

class SnapshotMoved extends Error {}

function generationOf(sql: SqlExec): number {
  const row = sql.exec(`SELECT ${CURRENT_GENERATION} AS g`).toArray()[0] as { g: number | null } | undefined;
  return Number(row?.g ?? 0);
}

export class ProfileStore {
  constructor(private deps: ProfileStoreDeps) {}

  private rows(paths?: string[]): FieldRow[] {
    const all = this.deps.sql
      .exec("SELECT path, sealed, source, document_id, updated_at FROM profile_fields ORDER BY rowid")
      .toArray() as unknown as FieldRow[];
    return paths ? all.filter((r) => paths.includes(r.path)) : all;
  }

  private async open(path: string, sealed: string): Promise<Value> {
    return JSON.parse(await this.deps.cipher.open(path, sealed)) as Value;
  }

  async read(): Promise<Profile> {
    await this.migrateMemoryOnce();
    const profile: Profile = { person: { address: {} }, household: [], income: [], programs: [] };
    const entries = new Map<string, Record<string, unknown>>();
    for (const row of this.rows()) {
      const leaf: Leaf<Value> = {
        value: await this.open(row.path, row.sealed),
        source: row.source,
        ...(row.document_id ? { documentId: row.document_id } : {}),
        updatedAt: row.updated_at,
      };
      const parts = row.path.split(".");
      if (parts[0] === "person") {
        const holder = (parts[1] === "address" ? profile.person.address : profile.person) as Record<string, unknown>;
        holder[parts[parts.length - 1]] = leaf;
        continue;
      }
      const [collection, id, field] = parts as [Collection, string, string];
      let entry = entries.get(`${collection}.${id}`);
      if (!entry) {
        entry = { id };
        entries.set(`${collection}.${id}`, entry);
        (profile[collection] as unknown[]).push(entry);
      }
      entry[field] = leaf;
    }
    return profile;
  }

  async suggestions(): Promise<Suggestion[]> {
    const rows = this.deps.sql
      .exec("SELECT path, source, sealed, document_id, suggested_at FROM profile_suggestions ORDER BY suggested_at, path")
      .toArray() as unknown as { path: string; source: ProfileSource; sealed: string; document_id: string | null; suggested_at: string }[];
    const out: Suggestion[] = [];
    for (const r of rows) {
      out.push({
        path: r.path,
        value: await this.open(r.path, r.sealed),
        source: r.source,
        ...(r.document_id ? { documentId: r.document_id } : {}),
        suggestedAt: r.suggested_at,
      });
    }
    return out;
  }

  async patch(raw: unknown, generation: number): Promise<PatchOutcome> {
    let parsed: ParsedPatch;
    try {
      parsed = parseProfilePatch(raw);
    } catch (err) {
      if (err instanceof ProfileInputError) return { status: "invalid", error: err.message };
      throw err;
    }
    if (parsed.documentId && !this.deps.documentExists(parsed.documentId)) {
      return { status: "invalid", error: "documentId names no document of this person." };
    }
    const requestHash = await sha256Hex(
      canonicalJson({ source: parsed.source, documentId: parsed.documentId, fields: (raw as { fields: unknown }).fields }),
    );
    await this.migrateMemoryOnce();
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.tryPatch(parsed, requestHash, generation);
      } catch (err) {
        if (!(err instanceof SnapshotMoved) || attempt >= 3) throw err;
      }
    }
  }

  private recorded(key: string, requestHash: string): PatchOutcome | null {
    const row = this.deps.sql.exec("SELECT request_hash, result_json FROM profile_patches WHERE idempotency_key = ?", key).toArray()[0] as
      | { request_hash: string; result_json: string }
      | undefined;
    if (!row) return null;
    if (row.request_hash !== requestHash) return { status: "conflict" };
    return { status: "ok", result: { ...(JSON.parse(row.result_json) as Omit<PatchResult, "replayed">), replayed: true } };
  }

  // Decides each set against what it would replace (apply, leave as is, or
  // keep as a suggestion), seals what will be written, then writes in one
  // transaction that re-checks the key, the generation and that nothing it
  // compared against moved in between.
  private async tryPatch(parsed: ParsedPatch, requestHash: string, generation: number): Promise<PatchOutcome> {
    const early = this.recorded(parsed.idempotencyKey, requestHash);
    if (early) return early;
    const trust = TRUST[parsed.source];
    const setPaths = parsed.sets.map((s) => s.path);
    const before = new Map(this.rows(setPaths).map((r) => [r.path, r]));
    const changed: { path: string; sealed: string }[] = [];
    const suggested: { path: string; sealed: string }[] = [];
    const unchanged: string[] = [];
    for (const set of parsed.sets) {
      const prior = before.get(set.path);
      const cleared = parsed.clears.some((c) => covers(c, set.path)) && (!prior || TRUST[prior.source] <= trust);
      const live = prior && !cleared ? prior : undefined;
      const sameValue = live ? (await this.open(live.path, live.sealed)) === set.value : false;
      if (live && TRUST[live.source] > trust) {
        if (sameValue) unchanged.push(set.path);
        else suggested.push({ path: set.path, sealed: await this.deps.cipher.seal(set.path, JSON.stringify(set.value)) });
      } else if (live && sameValue && live.source === parsed.source && (live.document_id ?? null) === parsed.documentId) {
        unchanged.push(set.path);
      } else {
        changed.push({ path: set.path, sealed: await this.deps.cipher.seal(set.path, JSON.stringify(set.value)) });
      }
    }
    const at = this.deps.now().toISOString();
    const sql = this.deps.sql;
    return this.deps.transaction((): PatchOutcome => {
      const late = this.recorded(parsed.idempotencyKey, requestHash);
      if (late) return late;
      if (generationOf(sql) !== generation) return { status: "stale" };
      const now = new Map(this.rows(setPaths).map((r) => [r.path, r.updated_at]));
      for (const path of setPaths) if (now.get(path) !== before.get(path)?.updated_at) throw new SnapshotMoved();
      for (const path of parsed.clears) {
        // Only what this source may overrule: a document never clears what
        // the person said.
        const rows = sql.exec(`SELECT path FROM profile_fields WHERE ${UNDER} AND ${TRUST_SQL} <= ?`, ...under(path), trust).toArray() as {
          path: string;
        }[];
        for (const r of rows) retireLinkedNotes(sql, r.path, false);
        sql.exec(`DELETE FROM profile_fields WHERE ${UNDER} AND ${TRUST_SQL} <= ?`, ...under(path), trust);
        sql.exec(`DELETE FROM profile_suggestions WHERE ${UNDER} AND ${TRUST_SQL} <= ?`, ...under(path), trust);
      }
      for (const c of changed) {
        retireLinkedNotes(sql, c.path, false);
        sql.exec(
          `INSERT INTO profile_fields(path, sealed, source, document_id, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET sealed = excluded.sealed, source = excluded.source,
             document_id = excluded.document_id, updated_at = excluded.updated_at`,
          c.path,
          c.sealed,
          parsed.source,
          parsed.documentId,
          at,
        );
      }
      // Saying a field again, or changing it, settles suggestions for it
      // from this source or a lower one.
      for (const path of [...changed.map((c) => c.path), ...unchanged]) {
        sql.exec(`DELETE FROM profile_suggestions WHERE path = ? AND ${TRUST_SQL} <= ?`, path, trust);
      }
      for (const s of suggested) {
        sql.exec(
          `INSERT INTO profile_suggestions(path, source, sealed, document_id, suggested_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(path, source) DO UPDATE SET sealed = excluded.sealed, document_id = excluded.document_id, suggested_at = excluded.suggested_at`,
          s.path,
          parsed.source,
          s.sealed,
          parsed.documentId,
          at,
        );
      }
      const result = {
        changed: changed.map((c) => c.path),
        unchanged,
        cleared: parsed.clears,
        suggested: suggested.map((s) => s.path),
      };
      sql.exec(
        "INSERT INTO profile_patches(idempotency_key, request_hash, result_json) VALUES (?, ?, ?)",
        parsed.idempotencyKey,
        requestHash,
        JSON.stringify(result),
      );
      return { status: "ok", result: { ...result, replayed: false } };
    });
  }

  // Runs once per person: memory notes that clearly name a profile fact
  // become that field with source agent, linked to the notes, which stay.
  // A field the profile already has is never overwritten. The write lands
  // only if the conversation generation and every source note are as they
  // were read; otherwise nothing is written and the next call starts over,
  // so a delete during sealing can never bring the data back.
  async migrateMemoryOnce(): Promise<number> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const moved = await this.tryMigrate();
      if (moved !== null) return moved;
    }
    return 0;
  }

  // null: memory or the generation moved while sealing; nothing written.
  private async tryMigrate(): Promise<number | null> {
    const sql = this.deps.sql;
    const done = () => sql.exec("SELECT 1 FROM profile_migrations WHERE name = ?", MEMORY_MIGRATION).toArray().length > 0;
    if (done()) return 0;
    const generation = generationOf(sql);
    const notes = hasMemoryTable(sql)
      ? (sql.exec("SELECT id, content, created_at AS createdAt FROM memory ORDER BY created_at").toArray() as unknown as {
          id: string;
          content: string;
          createdAt: string;
        }[])
      : [];
    const sealed: { path: string; sealed: string; at: string; noteIds: string[] }[] = [];
    for (const [path, field] of profileFieldsFromMemory(notes)) {
      sealed.push({ path, sealed: await this.deps.cipher.seal(path, JSON.stringify(field.value)), at: field.at, noteIds: field.noteIds });
    }
    return this.deps.transaction((): number | null => {
      if (done()) return 0;
      if (generationOf(sql) !== generation) return null;
      const sourceIds = [...new Set(sealed.flatMap((s) => s.noteIds))];
      const present = new Set(
        hasMemoryTable(sql) ? (sql.exec("SELECT id FROM memory").toArray() as { id: string }[]).map((r) => r.id) : [],
      );
      if (sourceIds.some((id) => !present.has(id))) return null;
      let moved = 0;
      for (const s of sealed) {
        const wrote =
          sql.exec(
            "INSERT INTO profile_fields(path, sealed, source, document_id, updated_at) VALUES (?, ?, 'agent', NULL, ?) ON CONFLICT(path) DO NOTHING",
            s.path,
            s.sealed,
            s.at,
          ).rowsWritten > 0;
        if (!wrote) continue;
        moved += 1;
        for (const id of s.noteIds) sql.exec("INSERT OR IGNORE INTO profile_memory_links(path, memory_id) VALUES (?, ?)", s.path, id);
      }
      sql.exec("INSERT INTO profile_migrations(name, at) VALUES (?, ?)", MEMORY_MIGRATION, this.deps.now().toISOString());
      return moved;
    });
  }
}

function covers(group: string, path: string): boolean {
  return path === group || path.startsWith(`${group}.`);
}

// What a patch answers over RPC: on success, with the profile as it now is.
export type PatchAnswer =
  | { status: "ok"; result: PatchResult; profile: Profile; suggestions: Suggestion[] }
  | Exclude<PatchOutcome, { status: "ok" }>
  | { status: "unavailable" };

export function profilePatchResponse(out: PatchAnswer): Response {
  switch (out.status) {
    case "ok":
      return Response.json({ ...out.result, profile: out.profile, suggestions: out.suggestions });
    case "invalid":
      return Response.json({ error: out.error }, { status: 400 });
    case "conflict":
      return Response.json({ error: "This idempotency key was already used for other fields. Nothing was written." }, { status: 409 });
    case "stale":
      return Response.json({ error: "This conversation was deleted after the request was prepared. Nothing was written." }, { status: 409 });
    case "unavailable":
      return Response.json({ error: "Profile storage is not configured." }, { status: 503 });
  }
}
