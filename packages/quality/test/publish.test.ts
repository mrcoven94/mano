// Review 3 item 1: a neutral run must post. The gate's outcome is data in
// gate.json, never a shell exit code, and publishing runs the same code CI
// runs: one comment edited in place, one check run whose conclusion is the
// gate, and a job exit code that is non-zero only for a failing or broken run.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { COMMENT_MARKER, exitCodeFor, publishSmoke, readOutcome } from "../src/publish.ts";

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

function fakeGitHub(existing: { id: number; body: string }[] = []) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, path: u.pathname, body });
    if (method === "GET") return new Response(JSON.stringify(existing), { status: 200 });
    if (method === "POST" && u.pathname.endsWith("/comments")) return new Response(JSON.stringify({ id: 501 }), { status: 201 });
    return new Response(JSON.stringify({ id: 9 }), { status: 200 });
  }) as typeof fetch;
  return { calls, target: { repo: "o/r", pr: 43, sha: "abc123", token: "t", fetchFn } };
}

function stage(gate: { status: string; reasons: string[] } | null): string {
  const dir = mkdtempSync(join(tmpdir(), "quality-publish-"));
  if (gate) {
    writeFileSync(join(dir, "gate.json"), JSON.stringify(gate));
    writeFileSync(join(dir, "comment.md"), `## Quality smoke: ${gate.status}\n\nnumbers`);
  }
  return dir;
}

test("a neutral run posts its comment and a neutral check, and the job passes", async () => {
  const outcome = readOutcome(stage({ status: "neutral", reasons: ["no baseline yet"] }));
  const gh = fakeGitHub();
  const posted = await publishSmoke(outcome, gh.target);
  const check = gh.calls.find((c) => c.path.endsWith("/check-runs"))!;
  assert.equal(check.body!.conclusion, "neutral");
  assert.equal(check.body!.head_sha, "abc123");
  assert.match(String((check.body!.output as { summary: string }).summary), /no baseline yet/);
  const comment = gh.calls.find((c) => c.method === "POST" && c.path.endsWith("/issues/43/comments"))!;
  assert.ok(String(comment.body!.body).startsWith(COMMENT_MARKER));
  assert.equal(posted.edited, false);
  assert.equal(exitCodeFor(outcome.status), 0);
});

test("the comment is edited in place on the next run, including the old unmarked one", async () => {
  const marked = fakeGitHub([{ id: 77, body: `${COMMENT_MARKER}\n## Quality smoke: pass` }]);
  const posted = await publishSmoke(readOutcome(stage({ status: "pass", reasons: [] })), marked.target);
  assert.equal(posted.edited, true);
  assert.ok(marked.calls.some((c) => c.method === "PATCH" && c.path.endsWith("/issues/comments/77")));
  assert.ok(!marked.calls.some((c) => c.method === "POST" && c.path.endsWith("/comments")));

  const legacy = fakeGitHub([{ id: 12, body: "## Quality smoke: neutral, not a pass\n\nold" }]);
  await publishSmoke(readOutcome(stage({ status: "pass", reasons: [] })), legacy.target);
  assert.ok(legacy.calls.some((c) => c.method === "PATCH" && c.path.endsWith("/issues/comments/12")));
});

test("pass, fail and a run that wrote nothing map to the right check and exit code", async () => {
  for (const [status, conclusion, code] of [["pass", "success", 0], ["fail", "failure", 1]] as const) {
    const gh = fakeGitHub();
    const outcome = readOutcome(stage({ status, reasons: status === "fail" ? ["judge mean 4.10 to 3.60"] : [] }));
    await publishSmoke(outcome, gh.target);
    assert.equal(gh.calls.find((c) => c.path.endsWith("/check-runs"))!.body!.conclusion, conclusion);
    assert.equal(exitCodeFor(outcome.status), code);
  }
  const broken = readOutcome(stage(null));
  assert.equal(broken.status, "error");
  assert.match(broken.comment, /stopped before scoring/);
  const gh = fakeGitHub();
  await publishSmoke(broken, gh.target);
  assert.equal(gh.calls.find((c) => c.path.endsWith("/check-runs"))!.body!.conclusion, "failure");
  assert.equal(exitCodeFor(broken.status), 1);
});

// Each step's name and its run block, read from the workflow file.
function runSteps(yaml: string): { name: string; run: string }[] {
  const steps: { name: string; run: string }[] = [];
  const lines = yaml.split("\n");
  let name = "";
  for (let i = 0; i < lines.length; i++) {
    const named = lines[i]!.match(/^ {6}- name: (.+)$/);
    if (named) name = named[1]!;
    if (/^ {8}run: \|$/.test(lines[i]!)) {
      const body: string[] = [];
      while (i + 1 < lines.length && /^ {10}/.test(lines[i + 1]!)) body.push(lines[++i]!.slice(10));
      steps.push({ name, run: body.join("\n") });
    }
  }
  return steps;
}

// The workflow's own steps, run the way Actions runs them (bash -e -o
// pipefail), with node replaced by a stub that plays a neutral smoke run.
// The publish step must still run and post.
test("under bash -e the workflow's publish step runs after a neutral smoke run", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const steps = runSteps(readFileSync(join(root, ".github", "workflows", "quality-smoke.yml"), "utf8"));
  const smoke = steps.find((s) => /smoke subset/i.test(s.name));
  const publish = steps.find((s) => /post the result/i.test(s.name));
  assert.ok(smoke && publish, `steps found: ${steps.map((s) => s.name).join(", ")}`);

  const work = mkdtempSync(join(tmpdir(), "quality-wf-"));
  const bin = join(work, "bin");
  mkdirSync(bin);
  mkdirSync(join(work, "packages", "quality"), { recursive: true });
  const log = join(work, "calls.log");
  // The stub node: smoke.ts writes a neutral result and exits 0 (as the
  // real one does), smoke-publish.ts records that it ran.
  writeFileSync(join(bin, "node"), `#!/bin/bash
for a in "$@"; do
  case "$a" in
    *smoke-publish.ts) echo "publish $*" >> ${JSON.stringify(log)}; exit 0;;
    *smoke.ts) mkdir -p ../../runs/smoke; echo '{"status":"neutral","reasons":["x"]}' > ../../runs/smoke/gate.json; echo "smoke" >> ${JSON.stringify(log)}; exit 0;;
  esac
done
exit 0
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const cwd = join(work, "packages", "quality");
  execFileSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", smoke!.run], { cwd, env });
  execFileSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", publish!.run], { cwd, env });
  const calls = execFileSync("cat", [log], { encoding: "utf8" });
  assert.match(calls, /^smoke\npublish /);
});
