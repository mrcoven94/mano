// Subprocess harness: the system under test runs as a separate node process
// that receives only input JSON (and staged image copies on the photo
// track). The system code is copied into the run dir and the child runs
// under Node's permission model: it may read only the run dir and the
// system temp dir, and write only the run dir. The child gets no network
// at all. Model calls and link checks travel over the fork IPC channel to
// the parent broker, which holds the key and an allowlist (see
// BROKER_RULES); anything else is denied. Answers, the generator, and the
// seed are never visible: the environment is scrubbed to PATH plus
// allow-listed keys, argv names only the run dir files, and held-out
// answers are never written to disk while a system runs.
import { fork, spawnSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, mkdir, copyFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";

// The harness refuses to run unless the runtime can deny network: a child
// that cannot be kept offline invalidates every isolation claim. Checked
// once per process by denying a real fetch in a throwaway child.
let netDenyVerified = false;
export function assertNetDenyCapable() {
  if (netDenyVerified) return;
  const probe = spawnSync(
    process.execPath,
    ["--permission", "-e", "fetch('https://example.com/').then(()=>console.log('NET-ALLOWED'),(e)=>console.log('NET-DENIED:'+((e.cause&&e.cause.code)||e.code||'none')))"],
    { encoding: "utf8", timeout: 15000 }
  );
  const out = `${probe.stdout || ""}${probe.stderr || ""}`;
  if (!out.includes("NET-DENIED:ERR_ACCESS_DENIED")) {
    throw new Error(`harness refuses to run: this Node (${process.versions.node}) cannot deny network; the eval needs Node 25 or later`);
  }
  netDenyVerified = true;
}

const CHANNEL = "mano-eval-broker";
const HELLO = "mano-eval-broker-hello";

// The only network the broker performs on a child's behalf: model calls
// and link-check DNS lookups. The key is injected here; the child never
// sees it.
const BROKER_RULES = [
  { host: "api.meta.ai", pathPrefix: "/v1/responses", methods: ["POST"], auth: true },
  { host: "security.cloudflare-dns.com", pathPrefix: "/dns-query", methods: ["GET"], auth: false },
];

function brokerRoute(url, method) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  return BROKER_RULES.find((r) => r.host === u.hostname && u.pathname.startsWith(r.pathPrefix) && r.methods.includes(method)) || null;
}

export async function withRunDir(fn) {
  // Resolved: the permission model checks literal path components, so any
  // symlink (like /tmp on macOS) would demand its ancestors too.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "mano-eval-run-")));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function scrubbedEnv(allow) {
  const env = { PATH: process.env.PATH || "/usr/bin:/bin" };
  for (const k of allow) {
    if (process.env[k]) env[k] = process.env[k];
  }
  return env;
}

// Run one system entry (node script taking --input <json> --out <json>)
// over all inputs. The child never gets network (netAllow stays for
// forwards-compatibility but is ignored: pass nothing). With broker: true
// the parent answers IPC fetch requests per BROKER_RULES. Returns
// { outputs, runs }.
export async function runSystem(entryFile, inputs, { envAllow = [], netAllow = [], timeoutMs = 1500000, broker = false, fetchImpl = fetch } = {}) {
  void netAllow;
  assertNetDenyCapable();
  return withRunDir(async (dir) => {
    // Stage the system code, inputs, and photo copies inside the run dir.
    const sysDir = join(dir, "sys", "systems");
    await mkdir(sysDir, { recursive: true });
    const stagedEntry = join(sysDir, basename(entryFile));
    await copyFile(entryFile, stagedEntry);
    const srcDir = dirname(dirname(entryFile));
    for (const f of ["baselines.mjs", "tools.mjs", "ipc.mjs"]) {
      try {
        await copyFile(join(srcDir, f), join(dir, "sys", f));
      } catch { /* probe entries travel without the package */ }
    }
    const assetsDir = join(dir, "assets");
    await mkdir(assetsDir, { recursive: true });
    const stagedInputs = [];
    for (const h of inputs) {
      const letters = [];
      for (const l of h.letters || []) {
        if (!l.photos) {
          letters.push(l);
          continue;
        }
        const staged = [];
        for (const p of l.photos) {
          const dest = join(assetsDir, basename(p));
          await copyFile(p, dest);
          staged.push(dest);
        }
        letters.push({ ...l, photos: staged });
      }
      stagedInputs.push({ ...h, letters });
    }
    const inputPath = join(dir, "input.json");
    const outputPath = join(dir, "output.json");
    await writeFile(inputPath, JSON.stringify(stagedInputs));
    const child = fork(
      stagedEntry,
      ["--input", inputPath, "--out", outputPath],
      {
        cwd: dir,
        env: scrubbedEnv(envAllow),
        silent: true,
        execArgv: [
          // One value per flag: comma-joined values are treated as one path.
          // The run dir is fully resolved, so no ancestor grant is needed
          // and the child reads nothing else, not even the OS temp dir.
          "--permission",
          `--allow-fs-read=${dir}`,
          `--allow-fs-write=${dir}`,
          // No --allow-net: the child is offline; the broker fetches for it.
        ],
      }
    );
    child.on("message", (msg) => {
      if (!msg || typeof msg !== "object" || msg.channel !== CHANNEL) return;
      const reply = (rest) => {
        try {
          child.send({ channel: CHANNEL, id: msg.id, ...rest });
        } catch { /* child went away */ }
      };
      void (async () => {
        if (!broker) {
          reply({ ok: false, error: "broker disabled" });
          return;
        }
        const route = brokerRoute(msg.url, msg.method || "GET");
        if (!route) {
          reply({ ok: false, error: "broker denied: not on the allowlist" });
          return;
        }
        const headers = { ...(msg.headers && typeof msg.headers === "object" ? msg.headers : {}) };
        if (route.auth) {
          const key = process.env.META_MODEL_API_KEY;
          if (!key) {
            reply({ ok: false, error: "broker has no key" });
            return;
          }
          headers.authorization = `Bearer ${key}`;
        }
        try {
          const res = await fetchImpl(msg.url, { method: msg.method || "GET", headers, body: msg.body });
          let json = null;
          try {
            json = await res.json();
          } catch {
            json = null;
          }
          reply({ ok: true, statusOk: res.ok === true, status: res.status ?? 0, json });
        } catch (err) {
          reply({ ok: false, error: `broker fetch failed: ${String((err && err.message) || err).slice(0, 200)}` });
        }
      })();
    });
    if (broker) {
      try {
        child.send({ channel: HELLO, keyAvailable: Boolean(process.env.META_MODEL_API_KEY) });
      } catch { /* child went away */ }
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    // A fork child stays alive while the IPC channel is open, so the
    // parent disconnects once the child wrote its output file (by
    // contract its last act) and gives it a grace period to exit.
    // Entries that never write output hit the timeout kill as before.
    const exit = await new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(watch);
        resolve(v);
      };
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch { /* already gone */ }
        finish({ code: "timeout", signal: "SIGKILL" });
      }, timeoutMs);
      child.on("close", (code, signal) => finish({ code, signal }));
      // After a parent-side disconnect the child exits but "close" may
      // never arrive, so "exit" resolves after a short stdio drain grace.
      // "close" normally wins the race through finish's done flag.
      child.on("exit", (code, signal) => {
        setTimeout(() => finish({ code, signal }), 300);
      });
      child.on("error", () => finish({ code: "spawn_error", signal: null }));
      let disconnecting = false;
      const watch = setInterval(() => {
        void (async () => {
          if (disconnecting) return;
          try {
            const st = await stat(outputPath);
            if (st.size === 0) return;
          } catch {
            return;
          }
          disconnecting = true;
          try {
            if (child.connected) child.disconnect();
          } catch { /* already gone */ }
          setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch { /* already gone */ }
          }, 5000);
        })();
      }, 100);
    });
    if (exit.code !== 0) {
      return {
        outputs: inputs.map((h) => ({
          householdId: h.householdId,
          baseline: "unknown",
          status: "error",
          reason: `system process failed: ${exit.code}`,
          reminders: [],
          packet: [],
          refused: [],
          enforced: [],
          requested: [],
          failures: [{ letterId: "*", reason: "system_crashed" }],
          toolCalls: [],
          costUsd: null,
          elapsedMs: 0,
          stderr: stderr.slice(0, 1000),
        })),
        runs: { exit, stdout: stdout.slice(0, 500), stderr: stderr.slice(0, 500) },
      };
    }
    const outputs = JSON.parse(await readFile(outputPath, "utf8"));
    return { outputs, runs: { exit } };
  });
}
