import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GlimmerChecker } from "../src/glimmer.js";
import type { CheckInput } from "../src/types.js";

const SERVER = fileURLToPath(new URL("../standin/server.mjs", import.meta.url));
const TOKEN = "stand-in-token";

let child: ChildProcess | null = null;

afterEach(() => {
  child?.kill();
  child = null;
});

async function startStandin(mode: string, extra: string[] = []): Promise<string> {
  child = spawn(process.execPath, [SERVER, "--mode", mode, ...extra], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (child.stdout === null) throw new Error("stand-in has no stdout");
  for await (const chunk of child.stdout) {
    const line = chunk.toString();
    const match = /STANDIN_READY (\S+)/.exec(line);
    if (match?.[1] !== undefined) return match[1];
  }
  await once(child, "exit");
  throw new Error("stand-in exited before becoming ready");
}

function passInput(): CheckInput {
  return {
    action: {
      type: "share",
      recipient: "Harbor Legal Aid",
      purpose: "Appeal help",
      payload: { claims: ["October earnings were $2,480."] },
      documentHash: null,
    },
    sources: [
      { kind: "document", id: "d1", quote: "October earnings were $2,480." },
    ],
    consents: [{ recipient: "Harbor Legal Aid", purpose: "Appeal help" }],
    origin: "person",
  };
}

describe("GlimmerChecker against the local stand-in", () => {
  it("passes a verdict through over real HTTP", async () => {
    const url = await startStandin("pass");
    const checker = new GlimmerChecker({ url, token: TOKEN });
    await expect(checker.check(passInput())).resolves.toEqual({
      verdict: "pass",
      problems: [],
    });
  });

  it("passes fix and block verdicts through", async () => {
    const fixUrl = await startStandin("fix");
    const fix = new GlimmerChecker({ url: fixUrl, token: TOKEN });
    const fixResult = await fix.check(passInput());
    expect(fixResult.verdict).toBe("fix");
    expect(fixResult.problems.length).toBeGreaterThan(0);
  });

  it("blocks when the token is wrong", async () => {
    const url = await startStandin("pass");
    const checker = new GlimmerChecker({ url, token: "wrong-token" });
    const result = await checker.check(passInput());
    expect(result.verdict).toBe("block");
  });

  it("blocks on an error status from the endpoint", async () => {
    const url = await startStandin("error");
    const checker = new GlimmerChecker({ url, token: TOKEN });
    const result = await checker.check(passInput());
    expect(result.verdict).toBe("block");
    expect(result.problems.join(" ")).toMatch(/returned an error/);
  });

  it("blocks when the endpoint answer is not strict JSON", async () => {
    const url = await startStandin("bad-json");
    const checker = new GlimmerChecker({ url, token: TOKEN });
    const result = await checker.check(passInput());
    expect(result.verdict).toBe("block");
    expect(result.problems.join(" ")).toMatch(/could not understand/);
  });

  it("blocks on timeout against a slow endpoint", async () => {
    const url = await startStandin("slow", ["--delay-ms", "5000"]);
    const checker = new GlimmerChecker({ url, token: TOKEN, timeoutMs: 200 });
    const result = await checker.check(passInput());
    expect(result.verdict).toBe("block");
    expect(result.problems.join(" ")).toMatch(/timed out/);
  });
});
