/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const WORKFLOW_URL = new URL("../../../.github/workflows/deploy-channels.yml", import.meta.url);

const REQUIRED = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "BLOOIO_API_KEY",
  "BLOOIO_CHANNEL_ID",
  "MANO_HANDLE_PEPPER",
  "ENCRYPTION_KEK_B64",
  "META_MODEL_API_KEY",
];

describe("deploy-channels workflow", () => {
  const yaml = readFileSync(WORKFLOW_URL, "utf8");

  it("verifies secrets before deploying", () => {
    const verifyAt = yaml.indexOf("Verify required secrets");
    const deployAt = yaml.indexOf("wrangler deploy");
    expect(verifyAt).toBeGreaterThan(-1);
    expect(deployAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeLessThan(deployAt);
    expect(yaml).toContain("exit $missing");
  });

  it("sets every required secret explicitly with no printenv loop", () => {
    expect(yaml).not.toContain("printenv");
    for (const name of REQUIRED) {
      if (name.startsWith("CLOUDFLARE_")) continue;
      expect(yaml).toContain(`wrangler secret put ${name}`);
    }
    expect(yaml).toContain("set -euo pipefail");
  });

  it("runs only on main, including manual dispatches", () => {
    expect(yaml).toContain("if: github.ref_name == 'main'");
  });

  it("names the same text-number variable the site reads", () => {
    const example = readFileSync(new URL("../../site/.env.example", import.meta.url), "utf8");
    const siteLib = readFileSync(new URL("../../site/lib/site.ts", import.meta.url), "utf8");
    for (const name of ["NEXT_PUBLIC_SMS_NUMBER", "NEXT_PUBLIC_APP_URL"]) {
      expect(example).toContain(`${name}=`);
      expect(siteLib).toContain(name);
    }
    expect(example).not.toContain("NEXT_PUBLIC_MANO_TEXT_NUMBER");
    expect(siteLib).not.toContain("NEXT_PUBLIC_MANO_TEXT_NUMBER");
  });

  it("never writes an empty optional secret", () => {
    expect(yaml).toContain('if [ -n "$1" ]');
    expect(yaml).toContain('maybe "$BLOOIO_WEBHOOK_SECRET" BLOOIO_WEBHOOK_SECRET');
  });
});
