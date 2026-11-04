// The person's documents as Engine records them: one row per stored file
// (each photo Channels stores from the text line), with when it arrived,
// what its bytes are and how large, what Mail found it to be, and the
// conversation generation it belongs to. The list also says whether the
// configured executor could file each one (filing), so Mano attaches a
// document the portal takes. The bytes stay in R2 (files.ts). A
// conversation delete removes the rows (agent-state.ts) and the files, so
// the list holds only the current conversation's documents, newest first.
//
// Routes (agent service, or the person's own session):
//   GET   /documents      { documents: PersonDocument[] }
//   PATCH /documents/:id  { kind, generation } what Mail found it to be;
//                         404 when no such document, 409 when a delete
//                         moved past the generation
import { isEmailDocument } from "@mano/protocol";

import { AgentStateInputError, currentGeneration, isGeneration } from "./agents/agent-state.js";
import { CURRENT_GENERATION } from "./gateway/sql-store.js";
import type { DocumentFiling, Executor } from "./gateway/types.js";

interface SqlExec {
  exec(query: string, ...bindings: unknown[]): { toArray(): unknown[]; rowsWritten: number };
}

export const DOCUMENT_KINDS = ["letter"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

// Read from the bytes' own signature, never from what a sender claims.
const MEDIA_TYPES = [
  { type: "application/pdf", noun: "PDF", magic: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { type: "image/png", noun: "photo", magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: "image/jpeg", noun: "photo", magic: [0xff, 0xd8, 0xff] },
] as const;
export type MediaType = (typeof MEDIA_TYPES)[number]["type"];

const KIND_NOUNS: Record<DocumentKind, string> = { letter: "letter" };

export interface PersonDocument {
  id: string;
  kind: DocumentKind | null;
  mediaType: MediaType | null;
  receivedAt: string;
  // How Mano names it to the person: "the letter you sent on November 2".
  label: string;
  generation: number;
  // null for a document stored before sizes were recorded.
  sizeBytes: number | null;
  filing: DocumentFiling;
}

export function mediaTypeOf(bytes: Uint8Array): MediaType | null {
  return MEDIA_TYPES.find((m) => bytes.length >= m.magic.length && m.magic.every((b, i) => bytes[i] === b))?.type ?? null;
}

// Rows stored before this list existed have no receive time or
// generation; they stay readable by ID and are never listed.
export function ensureDocumentTables(sql: SqlExec): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL, r2_key TEXT NOT NULL)`);
  const have = new Set((sql.exec("PRAGMA table_info(documents)").toArray() as { name: string }[]).map((c) => c.name));
  for (const [name, type] of [["received_at", "TEXT"], ["generation", "INTEGER"], ["kind", "TEXT"], ["media_type", "TEXT"], ["size_bytes", "INTEGER"]]) {
    if (!have.has(name)) sql.exec(`ALTER TABLE documents ADD COLUMN ${name} ${type}`);
  }
}

// Inserts only while the generation is current. False when the ID is
// already taken or a delete moved past the generation.
export function recordDocument(
  sql: SqlExec,
  doc: {
    id: string;
    name: string;
    hash: string;
    r2Key: string;
    mediaType: MediaType | null;
    sizeBytes: number;
    receivedAt: string;
    generation: number;
  },
): boolean {
  return (
    sql.exec(
      "INSERT OR IGNORE INTO documents(id, name, hash, r2_key, media_type, size_bytes, received_at, generation)" +
        ` SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${CURRENT_GENERATION} = ?`,
      doc.id, doc.name, doc.hash, doc.r2Key, doc.mediaType, doc.sizeBytes, doc.receivedAt, doc.generation, doc.generation,
    ).rowsWritten > 0
  );
}

const dayFormats = new Map<string, Intl.DateTimeFormat>();

function dayIn(receivedAt: string, timeZone: string): string {
  let format = dayFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone, month: "long", day: "numeric" });
    dayFormats.set(timeZone, format);
  }
  return format.format(new Date(receivedAt));
}

// timeZone: the person's, so the day is the one they sent it on.
// executor: the one Engine files through, which judges each document by
// its recorded media type and size.
export function listDocuments(sql: SqlExec, timeZone: string, executor: Pick<Executor, "documentFiling">): PersonDocument[] {
  const rows = sql.exec(
    "SELECT id, kind, media_type, size_bytes, received_at, generation FROM documents" +
      ` WHERE received_at IS NOT NULL AND generation = ${CURRENT_GENERATION} ORDER BY received_at DESC, rowid DESC`,
  ).toArray() as {
    id: string;
    kind: DocumentKind | null;
    media_type: MediaType | null;
    size_bytes: number | null;
    received_at: string;
    generation: number;
  }[];
  return rows.map((r) => {
    const sizeBytes = r.size_bytes === null ? null : Number(r.size_bytes);
    const noun = r.kind ? KIND_NOUNS[r.kind] : (MEDIA_TYPES.find((m) => m.type === r.media_type)?.noun ?? "file");
    return {
      id: r.id,
      kind: r.kind,
      mediaType: r.media_type,
      receivedAt: r.received_at,
      label: `the ${noun} ${isEmailDocument(r.id) ? "that came by email" : "you sent"} on ${dayIn(r.received_at, timeZone)}`,
      generation: Number(r.generation),
      sizeBytes,
      filing: executor.documentFiling?.({ mediaType: r.media_type, sizeBytes }) ?? "fileable",
    };
  });
}

export function parseDocumentMark(raw: unknown): { kind: DocumentKind; generation: number } {
  const f = (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  if (!DOCUMENT_KINDS.includes(f.kind as DocumentKind)) {
    throw new AgentStateInputError(`kind must be one of ${DOCUMENT_KINDS.join(", ")}.`);
  }
  if (!isGeneration(f.generation)) throw new AgentStateInputError("generation must be a whole number, 0 or more.");
  return { kind: f.kind as DocumentKind, generation: f.generation };
}

// Records what Mail found a document to be. Marking it again is the same.
export function markDocument(sql: SqlExec, id: string, mark: { kind: DocumentKind; generation: number }): "marked" | "missing" | "stale" {
  if (currentGeneration(sql) !== mark.generation) return "stale";
  const where = `id = ? AND received_at IS NOT NULL AND generation = ${CURRENT_GENERATION}`;
  if (sql.exec(`SELECT 1 FROM documents WHERE ${where}`, id).toArray().length === 0) return "missing";
  sql.exec(`UPDATE documents SET kind = ? WHERE ${where}`, mark.kind, id);
  return "marked";
}
