// The staff page's slice of @mano/quality: signed R2 reads and the model-name
// filter, with no model clients, persona or channels code, so the site bundle
// stays small. Import it as "@mano/quality/site".
export { PRIVATE_BUCKET, PUBLIC_BUCKET, r2CredsFromEnv, r2GetJson } from "./r2.ts";
export type { R2Creds } from "./r2.ts";
export { scrubStaffCase, stripModelNames } from "./redact.ts";
export type { StaffCase } from "./redact.ts";
export type { HistoryRow, HistorySuite } from "./report.ts";
export type { CaseResult, RunReport, SuiteScore } from "./run.ts";
