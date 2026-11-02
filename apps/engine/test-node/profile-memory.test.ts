import { describe, expect, it } from "vitest";
import { profileFieldsFromMemory } from "../src/profile.js";

// Which older memory notes become profile fields: only a note that says
// one profile fact whole. Everything else stays only in memory.

const at = "2026-10-29T12:00:00.000Z";
const notes = (...contents: string[]) => contents.map((content) => ({ content, createdAt: at }));
const fields = (...contents: string[]) => Object.fromEntries([...profileFieldsFromMemory(notes(...contents))].map(([p, v]) => [p, v.value]));

describe("memory notes that map to the profile", () => {
  it("maps the clear ones", () => {
    expect(
      fields(
        "Lives in Salt Lake County",
        "Prefers Spanish",
        "Email is rosa.testcase@example.com",
        "Zip code is 84101",
        "Medicaid case number is TEST-12",
        "Born on 1990-02-03",
      ),
    ).toEqual({
      "person.county": "Salt Lake County",
      "person.language": "Spanish",
      "person.email": "rosa.testcase@example.com",
      "person.address.zip": "84101",
      "programs.medicaid.program": "Medicaid",
      "programs.medicaid.caseNumber": "TEST-12",
      "person.dateOfBirth": "1990-02-03",
    });
  });

  it("leaves ambiguous notes in memory", () => {
    expect(
      fields(
        "Has two kids",
        "Lives near Salt Lake County with her sister",
        "Prefers Spanish food",
        "Born on March 3",
        "Wants help with rent",
        "Asked about SNAP",
      ),
    ).toEqual({});
  });

  it("drops a field two notes disagree on", () => {
    expect(fields("Lives in Davis County", "Lives in Weber County", "Prefers Spanish")).toEqual({ "person.language": "Spanish" });
  });
});
