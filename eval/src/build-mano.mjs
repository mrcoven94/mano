// Bundles the Mano entry and @mano/mail into one file for the run directory,
// since the child under test can read nothing else. sharp stays external: it
// is a native module, so the harness links it in and grants read access to the
// installed packages and no other part of the repo. Answers stay out of reach.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));

export async function buildMano() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "mano-eval-build-")));
  const entry = join(dir, "systems", "mano.mjs");
  await build({
    entryPoints: [join(here, "systems", "mano.mjs")],
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node25",
    external: ["sharp", "heic-decode"],
    logLevel: "silent",
  });
  const sharpDir = await realpath(join(here, "..", "node_modules", "sharp"));
  const installed = sharpDir.slice(0, sharpDir.indexOf("/node_modules/.pnpm/") + "/node_modules/.pnpm".length);
  return {
    entry,
    sandbox: { allowAddons: true, allowFsRead: [installed], links: { sharp: sharpDir } },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
