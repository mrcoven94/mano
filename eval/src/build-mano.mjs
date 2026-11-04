// Bundles the Mano entry and @mano/mail into one file for the run directory,
// since the child under test can read nothing else. sharp stays external: it
// is a native module, so the harness links it in, grants read access to the
// installed packages and no other part of the repo, and runs the child in the OS
// sandbox because Node's own permission model does not bind native code.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { registerTemp } from "./cleanup.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// Where sharp and the rest of the installed packages live.
export async function installedPackages() {
  const sharpDir = await realpath(join(here, "..", "node_modules", "sharp"));
  return { sharpDir, installed: sharpDir.slice(0, sharpDir.indexOf("/node_modules/.pnpm/") + "/node_modules/.pnpm".length) };
}

// The hash of everything Mano's child would run. The freeze pins it.
export async function manoBundleHash() {
  const built = await buildMano();
  try {
    return createHash("sha256").update(await readFile(built.entry)).digest("hex");
  } finally {
    await built.cleanup();
  }
}

export async function buildMano() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "mano-eval-build-")));
  const unregister = registerTemp(dir);
  const entry = join(dir, "systems", "mano.mjs");
  await build({
    entryPoints: [join(here, "systems", "mano.mjs")],
    // A fixed working dir keeps the bundle's bytes the same on every run, and no
    // tsconfig is discovered, so no file outside the freeze can remap an import.
    absWorkingDir: join(here, ".."),
    tsconfigRaw: "{}",
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node25",
    external: ["sharp", "heic-decode"],
    logLevel: "silent",
  });
  const { sharpDir, installed } = await installedPackages();
  return {
    entry,
    sandbox: { allowAddons: true, allowFsRead: [installed], links: { sharp: sharpDir } },
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
      unregister();
    },
  };
}
