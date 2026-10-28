import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "scripts", "require-deploy-secrets.sh");
const workflow = join(here, "..", "..", "..", ".github", "workflows", "deploy-sandbox-portal.yml");

function runGuard(env: Record<string, string>): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile("bash", [script], { env: { ...process.env, ...env } }, (error, _stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stderr: String(stderr) });
    });
  });
}

describe("review round 2 item 7: deploy refuses empty secrets", () => {
  test("the guard passes only when all three secrets are set and non-empty", async () => {
    const full: Record<string, string> = { CLOUDFLARE_API_TOKEN: "dummy", CLOUDFLARE_ACCOUNT_ID: "dummy", SANDBOX_PORTAL_TOKEN: "dummy" };
    expect((await runGuard(full)).code).toBe(0);
    for (const missing of Object.keys(full)) {
      const { [missing]: _dropped, ...rest } = full;
      const result = await runGuard(rest);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(missing);
    }
    const empty = await runGuard({ ...full, SANDBOX_PORTAL_TOKEN: "" });
    expect(empty.code).not.toBe(0);
  });

  test("the deploy workflow runs the guard under bash before wrangler", async () => {
    const yaml = readFileSync(workflow, "utf8");
    const guard = yaml.indexOf("require-deploy-secrets.sh");
    const deploy = yaml.indexOf("wrangler deploy");
    expect(guard).toBeGreaterThan(-1);
    expect(deploy).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(deploy);
    expect(yaml).toContain("shell: bash");
  });
});
