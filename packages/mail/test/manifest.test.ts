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
  it("asks mail-04-p2's deadlines and publishes none", () => {
    const p2 = manifest().photos.find((p) => p.file === "mail-04-p2.jpg");
    expect(p2).toBeDefined();
    expect(p2!.letters).toHaveLength(1);
    // Page 2 restates the December 12 paperwork date but also carries
    // the anchorless 14-day hearing sentence, so withholding is
    // letter-wide: both asked, none published.
    expect(p2!.letters[0]!.deadlineIso).toBeNull();
    expect(p2!.questions).toContain("missing_page");
    expect(p2!.questions).toContain("confirm_deadline");
  });
});
