// Removes temp dirs and stops children when a run is interrupted, so SIGINT or
// SIGTERM never leaves held-out photos or staged household text on disk. Normal
// exits still clean up through finally blocks and unregister here.
import { rmSync } from "node:fs";

const dirs = new Set();
const children = new Set();
let installed = false;

function install() {
  if (installed) return;
  installed = true;
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    process.on(signal, () => {
      for (const child of children) {
        try {
          child.kill("SIGKILL");
        } catch { /* already gone */ }
      }
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
      process.exit(code);
    });
  }
}

export function registerTemp(dir) {
  install();
  dirs.add(dir);
  return () => dirs.delete(dir);
}

export function registerChild(child) {
  install();
  children.add(child);
  child.on("exit", () => children.delete(child));
}
