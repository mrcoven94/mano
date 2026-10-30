// Moves staged nightly output to R2: public/ to mano-quality (aggregates
// only) and private/ to mano-quality-private (per-case results). Reads go
// through the same signed requests, so neither bucket needs a public URL.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { PRIVATE_BUCKET, PUBLIC_BUCKET, r2GetJson, r2Put, type R2Creds } from "./r2.ts";

function files(dir: string): string[] {
  let out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of names) {
    const full = join(dir, name);
    out = statSync(full).isDirectory() ? [...out, ...files(full)] : [...out, full];
  }
  return out;
}

export async function uploadStaging(root: string, creds: R2Creds, fetchFn: typeof fetch = fetch): Promise<{ bucket: string; key: string }[]> {
  const sent: { bucket: string; key: string }[] = [];
  for (const [sub, bucket] of [["private", PRIVATE_BUCKET], ["public", PUBLIC_BUCKET]] as const) {
    const base = join(root, sub);
    // History and latest go last, so a reader never sees a history row whose
    // private run is not uploaded yet.
    const list = files(base).sort((a, b) => Number(a.endsWith("history.json")) - Number(b.endsWith("history.json")));
    for (const file of list) {
      const key = relative(base, file).split(sep).join("/");
      await r2Put(creds, bucket, key, readFileSync(file), "application/json", fetchFn);
      sent.push({ bucket, key });
    }
  }
  return sent;
}

export async function readPublic<T>(creds: R2Creds, key: string, fetchFn: typeof fetch = fetch): Promise<T | null> {
  return r2GetJson<T>(creds, PUBLIC_BUCKET, key, fetchFn);
}
