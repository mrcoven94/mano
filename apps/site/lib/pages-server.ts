import { MemoryPageStore, R2PageStore, r2ConfigFromEnv, type PagesDeps, type PageStore } from "@mano/pages";

let memory: MemoryPageStore | null = null;
let warnedStore = false;

export function pagesDeps(baseUrl = "https://withmano.com"): PagesDeps {
  const onVercel = process.env.VERCEL === "1";
  const r2 = r2ConfigFromEnv(process.env);
  let store: PageStore;
  if (r2) {
    store = new R2PageStore(r2);
  } else {
    if (!memory) memory = new MemoryPageStore();
    store = memory;
    if (!warnedStore) {
      warnedStore = true;
      console.warn("[pages] R2 is not configured, so pages live in memory on this instance only");
    }
  }
  return {
    store,
    secrets: {
      hmacSecret: process.env.MANO_PAGES_HMAC_SECRET ?? "",
      kekB64: process.env.MANO_PAGES_KEK_B64 || null,
      allowInsecure: !onVercel,
    },
    baseUrl: baseUrl.replace(/\/$/, ""),
    nowMs: Date.now,
    log: (line) => console.log(`[pages] ${line}`),
  };
}
