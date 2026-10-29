import { describe, expect, it } from "vitest";

import { addFact, initialPersonMemory, removeFact, renderMemory } from "../agent/lib/memory.js";
import { detectCrisis } from "../agent/lib/crisis.js";
import { parseDecision } from "../agent/lib/decision.js";

describe("person memory", () => {
  it("adds, dedupes, and renders facts", () => {
    let memory = initialPersonMemory();
    expect(renderMemory(memory)).toBeNull();
    memory = addFact(memory, "Lives in Salt Lake County");
    memory = addFact(memory, "  Lives in Salt Lake County  ");
    expect(memory.facts).toEqual(["Lives in Salt Lake County"]);
    expect(renderMemory(memory)).toContain("Salt Lake County");
  });

  it("removes facts case-insensitively", () => {
    let memory = addFact(initialPersonMemory(), "Has two kids");
    memory = removeFact(memory, "has two kids");
    expect(memory.facts).toEqual([]);
    expect(removeFact(memory, "missing")).toBe(memory);
  });

  it("caps facts and length", () => {
    let memory = initialPersonMemory();
    for (let i = 0; i < 60; i++) memory = addFact(memory, `fact ${i}`);
    expect(memory.facts).toHaveLength(50);
    memory = addFact(initialPersonMemory(), "x".repeat(600));
    expect(memory.facts[0]).toHaveLength(500);
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
