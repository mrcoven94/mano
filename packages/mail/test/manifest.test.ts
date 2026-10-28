import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface ManifestPhoto {
  file: string;
  questions: string[];
  letters: { id: string; deadlineIso: string | null }[];
}

function manifest(): { photos: ManifestPhoto[] } {
  const path = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "manifest.json");
  return JSON.parse(readFileSync(path, "utf8")) as { photos: ManifestPhoto[] };
}

describe("dev-set manifest", () => {
  it("keeps mail-04-p2's December 12 deadline and expects the hearing question", () => {
    const p2 = manifest().photos.find((p) => p.file === "mail-04-p2.jpg");
    expect(p2).toBeDefined();
    expect(p2!.letters).toHaveLength(1);
    // Page 2 restates the paperwork deadline, so the key keeps it;
    // dropping it must score a miss, not full marks.
    expect(p2!.letters[0]!.deadlineIso).toBe("2026-12-12");
    // Its 14-day hearing sentence has no anchor date, so the photo
    // must ask about that deadline too.
    expect(p2!.questions).toContain("missing_page");
    expect(p2!.questions).toContain("confirm_deadline");
  });
});
