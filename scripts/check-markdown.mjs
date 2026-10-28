// Fails when the repo holds a Markdown file outside the allowlist (AGENTS.md, hard rule 12).
import { execFileSync } from "node:child_process";

const allowed = new Set([
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "docs/decisions.md",
  "docs/protocol.md",
  "docs/third-party.md",
]);

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => /\.mdx?$/i.test(f));
const stray = files.filter((f) => !allowed.has(f));

if (stray.length > 0) {
  console.error("Markdown files outside the allowlist (AGENTS.md, hard rule 12):");
  for (const f of stray) console.error(`  ${f}`);
  console.error("Put usage in the root README.md or a header comment, reports in the pull request, plans in Linear.");
  process.exit(1);
}
console.log(`markdown: ${files.length} allowed files, none stray`);
