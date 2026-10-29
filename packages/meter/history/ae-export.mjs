// @mano/meter history: nightly Analytics Engine export (plain node,
// no deps). Queries the mano_model_usage dataset through the AE SQL
// API and writes one JSON lines file per UTC day plus an index:
//
//   <out>/records/2026-10-29.jsonl
//   <out>/index.json
//
// The workflow uploads these to the mano-meter R2 bucket, where /stats
// reads them (see src/r2.js). Rows are mapped back to record shape by
// column position; the lists below mirror POINT_BLOB_KEYS and
// POINT_DOUBLE_KEYS in src/analytics.js, and the ae-export test fails
// if they drift. Malformed rows are skipped and counted in the index,
// never written. Strict label validation happens at render time, when
// the loader re-validates every line through buildRecord.
//
// Env: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (needs Analytics
// Engine read), METER_ANALYTICS_DATASET (default mano_model_usage).
// Flags: --out <dir> (required), --days <n> (default 90).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Mirrors POINT_BLOB_KEYS / POINT_DOUBLE_KEYS in src/analytics.js.
// Column N in the query below is blob/double N.
export const AE_BLOB_KEYS = [
  "package",
  "purpose",
  "provider",
  "model",
  "dataClass",
  "environment",
  "status",
  "at",
];

export const AE_DOUBLE_KEYS = [
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "latencyMs",
  "estimatedCostUsd",
];

// Record key order for exported lines. Mirrors RECORD_KEYS in
// src/record.js; the ae-export test fails if the two drift.
export const AE_RECORD_KEYS = [
  "package",
  "purpose",
  "provider",
  "model",
  "dataClass",
  "environment",
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "latencyMs",
  "status",
  "estimatedCostUsd",
  "at",
];

export const EXPORT_LIMIT = 200000;
export const DEFAULT_DATASET = "mano_model_usage";
const DATASET_PATTERN = /^[A-Za-z0-9_-]+$/;

export function buildUsageQuery(dataset, days) {
  if (!DATASET_PATTERN.test(dataset ?? "")) throw new Error(`Refusing to query dataset ${JSON.stringify(dataset)}.`);
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1 || n > 365) throw new Error(`Export days must be 1-365, got ${JSON.stringify(days)}.`);
  const blobs = AE_BLOB_KEYS.map((_, i) => `blob${i + 1}`).join(", ");
  const doubles = AE_DOUBLE_KEYS.map((_, i) => `double${i + 1}`).join(", ");
  // Lowercase now(): the endpoint rejects NOW(). timestamp must be
  // selected for ORDER BY to resolve. Both verified against the live
  // API, which also wants the raw SQL as the request body.
  return `SELECT timestamp, ${blobs}, ${doubles} FROM ${dataset} WHERE timestamp > now() - INTERVAL '${n}' DAY ORDER BY timestamp LIMIT ${EXPORT_LIMIT}`;
}

function cleanCount(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
}

function cleanCost(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : null;
}

// One AE row object ({ blob1, ..., double5 }) back to a record-shaped
// object, or null when the row is malformed. Labels pass through
// unchecked here; the R2 loader re-validates them with buildRecord.
export function rowToRecord(row) {
  if (typeof row !== "object" || row === null) return null;
  const labels = {};
  for (let i = 0; i < AE_BLOB_KEYS.length; i += 1) {
    const value = row[`blob${i + 1}`];
    if (typeof value !== "string" || value === "") return null;
    labels[AE_BLOB_KEYS[i]] = value;
  }
  const numbers = {};
  for (let i = 0; i < 4; i += 1) {
    const value = cleanCount(row[`double${i + 1}`]);
    if (value === null) return null;
    numbers[AE_DOUBLE_KEYS[i]] = value;
  }
  const cost = cleanCost(row.double5);
  if (cost === null) return null;
  numbers.estimatedCostUsd = cost;
  if (!/^\d{4}-\d{2}-\d{2}/.test(labels.at)) return null;
  return { ...labels, ...numbers };
}

export function dayOfRecord(record) {
  return record.at.slice(0, 10);
}

export function formatRecordLine(record) {
  const picked = {};
  for (const key of AE_RECORD_KEYS) picked[key] = record[key];
  return JSON.stringify(picked);
}

// Records grouped by UTC day, each a JSONL string. Days sort ascending.
export function groupByDay(records) {
  const groups = new Map();
  for (const record of records) {
    const day = dayOfRecord(record);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(record);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, dayRecords]) => ({ day, jsonl: dayRecords.map(formatRecordLine).join("\n") + "\n" }));
}

export function rowsToDayFiles(rows) {
  const records = [];
  let skippedRows = 0;
  for (const row of rows) {
    const record = rowToRecord(row);
    if (record === null) skippedRows += 1;
    else records.push(record);
  }
  return { files: groupByDay(records), skippedRows, truncated: rows.length >= EXPORT_LIMIT };
}

export function buildUsageIndex(days, { generatedAt, dataset, skippedRows, truncated }) {
  return { generatedAt, dataset, days, skippedRows, truncated };
}

function parseArgs(argv) {
  const opts = { out: null, days: 90, dataset: process.env.METER_ANALYTICS_DATASET ?? DEFAULT_DATASET };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") opts.out = argv[++i] ?? null;
    else if (argv[i] === "--days") opts.days = argv[++i] ?? opts.days;
    else if (argv[i] === "--dataset") opts.dataset = argv[++i] ?? opts.dataset;
    else throw new Error(`Unknown flag ${argv[i]}.`);
  }
  if (!opts.out) throw new Error("Pass --out <dir>.");
  return opts;
}

async function queryAnalyticsEngine({ accountId, apiToken, dataset, days }) {
  if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is not set.");
  if (!apiToken) throw new Error("CLOUDFLARE_API_TOKEN is not set.");
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiToken}`, "content-type": "text/plain" },
    body: buildUsageQuery(dataset, days),
  });
  if (!res.ok) throw new Error(`Analytics Engine query failed: ${res.status}.`);
  const body = await res.json().catch(() => null);
  // The API answers { meta, data, rows, rows_before_limit_at_least };
  // a bare row array is accepted too, defensively.
  const rows = Array.isArray(body) ? body : body?.data;
  if (!Array.isArray(rows)) throw new Error("Analytics Engine returned an unexpected shape.");
  return rows;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rows = await queryAnalyticsEngine({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    dataset: opts.dataset,
    days: opts.days,
  });
  const { files, skippedRows, truncated } = rowsToDayFiles(rows);
  const recordsDir = join(opts.out, "records");
  mkdirSync(recordsDir, { recursive: true });
  for (const file of files) writeFileSync(join(recordsDir, `${file.day}.jsonl`), file.jsonl);
  const index = buildUsageIndex(files.map((file) => file.day), {
    generatedAt: new Date().toISOString(),
    dataset: opts.dataset,
    skippedRows,
    truncated,
  });
  mkdirSync(dirname(join(opts.out, "index.json")), { recursive: true });
  writeFileSync(join(opts.out, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  console.log(`exported ${files.reduce((n, file) => n + file.jsonl.trim().split("\n").length, 0)} records over ${files.length} days (${skippedRows} malformed rows skipped)`);
}

const invokedAsScript = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
