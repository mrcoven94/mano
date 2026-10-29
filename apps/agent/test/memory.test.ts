import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { engineFromEnv, personIdFor } from "../agent/lib/engine.js";
import { recallFacts, renderMemory } from "../agent/lib/memory.js";
import forget from "../agent/tools/forget.js";
import remember from "../agent/tools/remember.js";
import { ENGINE_SECRET, ENGINE_URL, EngineDouble } from "./engine-double.js";
import { detectCrisis } from "../agent/lib/crisis.js";
import { parseDecision } from "../agent/lib/decision.js";

const HANDLE = "c".repeat(64);
const ctx = { session: { auth: { current: { principalId: HANDLE, attributes: { turnId: "turn_memory0001" } } } } } as never;

let engine: EngineDouble;

beforeEach(() => {
  engine = new EngineDouble();
  vi.stubEnv("ENGINE_URL", ENGINE_URL);
  vi.stubEnv("ENGINE_SESSION_SECRET", ENGINE_SECRET);
  vi.stubGlobal("fetch", engine.fetch);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function recalled(): Promise<string[]> {
  return recallFacts(engineFromEnv()!, personIdFor(HANDLE));
}

describe("person memory in Engine", () => {
  it("remembers a fact on the person's Engine record, once", async () => {
    await remember.execute({ fact: "Lives in Salt Lake County" }, ctx);
    await remember.execute({ fact: "  lives in salt lake county " }, ctx);
    expect(engine.memory.get(personIdFor(HANDLE))?.map((r) => r.content)).toEqual(["Lives in Salt Lake County"]);
    expect(renderMemory(await recalled())).toContain("Salt Lake County");
    expect(renderMemory([])).toBeNull();
  });

  it("forget says plainly that deletion is unavailable while Engine has no delete route", async () => {
    await remember.execute({ fact: "Has two kids" }, ctx);
    expect(await forget.execute({ fact: "has two kids" }, ctx)).toEqual({ removed: false, reason: "deletion_unavailable" });
    expect(await recalled()).toEqual(["Has two kids"]);
  });

  it("forget deletes the fact once Engine supports deletion", async () => {
    engine.supportsMemoryDelete = true;
    await remember.execute({ fact: "Has two kids" }, ctx);
    expect(await forget.execute({ fact: "has two kids" }, ctx)).toEqual({ removed: true });
    expect(await recalled()).toEqual([]);
    expect(await forget.execute({ fact: "has two kids" }, ctx)).toEqual({ removed: false, reason: "not_found" });
  });

  it("memory tools refuse when Engine is not configured", async () => {
    vi.stubEnv("ENGINE_URL", "");
    await expect(remember.execute({ fact: "x" }, ctx)).rejects.toThrow(/not available/);
  });
});

describe("crisis detector", () => {
  it("matches crisis phrases and ignores ordinary text", () => {
    expect(detectCrisis("I want to kill myself")).toBe(true);
    expect(detectCrisis("thinking about suicide lately")).toBe(true);
    expect(detectCrisis("I got a letter saying my food benefits end next month")).toBe(false);
    expect(detectCrisis("remind me tomorrow at 9")).toBe(false);
  });
});

describe("yes/no decisions", () => {
  it("parses yes and no variants", () => {
    for (const text of ["yes", "YES!", "y", "ok", "sure", "go ahead", "1", "approve"]) {
      expect(parseDecision(text)).toBe("yes");
    }
    for (const text of ["no", "N", "nope", "don't", "stop", "cancel", "2", "not yet"]) {
      expect(parseDecision(text)).toBe("no");
    }
  });

  it("fails closed on anything else", () => {
    for (const text of ["maybe", "which form?", "", "yesterday", "note that down"]) {
      expect(parseDecision(text)).toBeNull();
    }
  });
});
