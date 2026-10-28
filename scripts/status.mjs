// Rewrites the "live versus in progress" table in README.md between the
// status markers. For each piece it fetches the health URL and asks GitHub for
// the latest deployment in that piece's environment.
//
// Run: node scripts/status.mjs [--check]
//   --check exits 1 when README.md would change, without writing.
//
// Env: GITHUB_TOKEN (or GH_TOKEN) reads deployments; without it the deploy
// column says "unknown". STATUS_<KEY>_URL overrides a piece's URL; an empty
// URL means the piece is not deployed yet. GITHUB_REPOSITORY defaults to
// mrcoven94/mano.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const README = join(root, "README.md");
const START = "<!-- status:start -->";
const END = "<!-- status:end -->";
const REPO = process.env.GITHUB_REPOSITORY ?? "mrcoven94/mano";
const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";

const SERVICES = [
  { piece: "Site", key: "SITE", environment: "site-production", url: "https://withmano.com" },
  { piece: "Sandbox portal", key: "SANDBOX_PORTAL", environment: "sandbox-portal-production", url: "https://mano-sandbox-portal.scholarfund.workers.dev" },
  { piece: "Engine", key: "ENGINE", environment: "engine-production", url: "" },
  { piece: "Channels", key: "CHANNELS", environment: "channels-production", url: "" },
  { piece: "Guardian", key: "GUARDIAN", environment: "guardian-production", url: "" },
  { piece: "Quality", key: "QUALITY", environment: "quality-production", url: "" },
];

function serviceUrl(service) {
  const override = process.env[`STATUS_${service.key}_URL`];
  return override !== undefined ? override.trim() : service.url;
}

async function checkHealth(url) {
  if (!url) return "in progress";
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: "follow" });
    return res.ok ? "live" : "down";
  } catch {
    return "down";
  }
}

async function latestDeploy(environment) {
  if (!TOKEN) return "unknown";
  try {
    const headers = { Accept: "application/vnd.github+json", Authorization: `Bearer ${TOKEN}` };
    const deployments = await fetch(
      `https://api.github.com/repos/${REPO}/deployments?environment=${environment}&per_page=1`,
      { headers, signal: AbortSignal.timeout(15000) },
    ).then((r) => (r.ok ? r.json() : null));
    if (!deployments || deployments.length === 0) return "none";
    const deploy = deployments[0];
    const statuses = await fetch(
      `https://api.github.com/repos/${REPO}/deployments/${deploy.id}/statuses?per_page=1`,
      { headers, signal: AbortSignal.timeout(15000) },
    ).then((r) => (r.ok ? r.json() : []));
    const state = statuses.length > 0 ? ` ${statuses[0].state}` : "";
    const day = String(deploy.created_at ?? "").slice(0, 10);
    return `${String(deploy.sha ?? "").slice(0, 7)}${state} ${day}`.trim();
  } catch {
    return "unknown";
  }
}

function buildTable(rows) {
  const lines = ["| Piece | Status | URL | Last deploy |", "| --- | --- | --- | --- |"];
  for (const row of rows) lines.push(`| ${row.piece} | ${row.status} | ${row.url} | ${row.deploy} |`);
  return lines.join("\n");
}

const rows = [];
for (const service of SERVICES) {
  const url = serviceUrl(service);
  const [status, deploy] = await Promise.all([checkHealth(url), latestDeploy(service.environment)]);
  rows.push({ piece: service.piece, status, url: url || "not deployed yet", deploy });
  console.log(`${service.piece}: ${status} ${url || "(no url)"} deploy=${deploy}`);
}

const table = buildTable(rows);
const readme = readFileSync(README, "utf8");
const start = readme.indexOf(START);
const end = readme.indexOf(END);
if (start === -1 || end === -1 || end < start) {
  console.error("README.md is missing the status markers");
  process.exit(1);
}
const next = `${readme.slice(0, start + START.length)}\n${table}\n${readme.slice(end)}`;
if (next === readme) {
  console.log("status: README.md already current");
} else if (process.argv.includes("--check")) {
  console.log("status: README.md would change");
  process.exit(1);
} else {
  writeFileSync(README, next);
  console.log("status: README.md updated");
}
