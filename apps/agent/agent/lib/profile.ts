// The person's profile as Engine holds it (Profile's contract): GET
// /profile answers { person, household, income, programs }, and every
// leaf is { value, source, documentId?, updatedAt }. Anything that does
// not have that shape is treated as absent, so a missing or malformed
// value becomes a question to the person, never a guess.
export type LeafSource = "person" | "document" | "agent";

export interface Leaf<T> {
  value: T;
  source: LeafSource;
  documentId?: string;
  updatedAt: string;
}

export type Frequency = "weekly" | "biweekly" | "monthly" | "yearly";

export interface Profile {
  person: {
    fullName?: Leaf<string>;
    dateOfBirth?: Leaf<string>;
    phone?: Leaf<string>;
    email?: Leaf<string>;
    address?: { line1?: Leaf<string>; line2?: Leaf<string>; city?: Leaf<string>; state?: Leaf<string>; zip?: Leaf<string> };
    county?: Leaf<string>;
    language?: Leaf<string>;
  };
  household: { id: string; name?: Leaf<string>; relationship?: Leaf<string>; dateOfBirth?: Leaf<string> }[];
  income: { id: string; memberId?: string; source?: Leaf<string>; amount?: Leaf<number>; frequency?: Leaf<Frequency> }[];
  programs: { program?: Leaf<string>; state?: Leaf<string>; caseNumber?: Leaf<string>; status?: Leaf<string> }[];
}

const SOURCES = new Set<string>(["person", "document", "agent"]);
const FREQUENCIES = new Set<string>(["weekly", "biweekly", "monthly", "yearly"]);

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function leaf<T>(raw: unknown, accept: (v: unknown) => v is T): Leaf<T> | undefined {
  const r = record(raw);
  if (!accept(r.value) || typeof r.source !== "string" || !SOURCES.has(r.source)) return undefined;
  const out: Leaf<T> = { value: r.value, source: r.source as LeafSource, updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : "" };
  if (typeof r.documentId === "string" && r.documentId) out.documentId = r.documentId;
  return out;
}

const text = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const amount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const frequency = (v: unknown): v is Frequency => typeof v === "string" && FREQUENCIES.has(v);

function pick<T>(target: Record<string, unknown>, raw: Record<string, unknown>, keys: string[], accept: (v: unknown) => v is T) {
  for (const key of keys) {
    const parsed = leaf(raw[key], accept);
    if (parsed) target[key] = parsed;
  }
}

function list(raw: unknown): Record<string, unknown>[] {
  return Array.isArray(raw) ? raw.map(record) : [];
}

export function parseProfile(raw: unknown): Profile {
  const body = record(raw);
  const personRaw = record(body.person);
  const person: Record<string, unknown> = {};
  pick(person, personRaw, ["fullName", "dateOfBirth", "phone", "email", "county", "language"], text);
  const address: Record<string, unknown> = {};
  pick(address, record(personRaw.address), ["line1", "line2", "city", "state", "zip"], text);
  if (Object.keys(address).length > 0) person.address = address;
  const household = list(body.household).map((m) => {
    const out: Record<string, unknown> = { id: typeof m.id === "string" ? m.id : "" };
    pick(out, m, ["name", "relationship", "dateOfBirth"], text);
    return out as Profile["household"][number];
  });
  const income = list(body.income).map((i) => {
    const out: Record<string, unknown> = { id: typeof i.id === "string" ? i.id : "" };
    if (typeof i.memberId === "string") out.memberId = i.memberId;
    pick(out, i, ["source"], text);
    pick(out, i, ["amount"], amount);
    pick(out, i, ["frequency"], frequency);
    return out as Profile["income"][number];
  });
  const programs = list(body.programs).map((p) => {
    const out: Record<string, unknown> = {};
    pick(out, p, ["program", "state", "caseNumber", "status"], text);
    return out as Profile["programs"][number];
  });
  return { person: person as Profile["person"], household, income, programs };
}
