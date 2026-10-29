// Stand-in for the guardian model endpoint. Serves the single POST /check
// route with scripted verdicts so GlimmerChecker runs end to end locally
// with no GPU and no keys. A body of {"warm":true} gets 202. Request bodies
// are never logged.
//
// Usage:
//   node standin/server.mjs [--port N]
//     [--mode pass|fix|block|bad-json|error|slow|contradictory|dup-keys]
//     [--require-token TOKEN] [--delay-ms N]
//
// Prints "STANDIN_READY <url>" on stdout once listening, with the /check path.
import http from "node:http";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
}

const port = Number(flag("--port", "0"));
const mode = flag("--mode", "pass");
const requireToken = flag("--require-token", "stand-in-token");
const delayMs = Number(flag("--delay-ms", "30000"));

const META = {
  model: { id: "stand-in", revision: "none" },
  image: { tag: "none", digest: "none" },
};

const VERDICTS = {
  pass: { verdict: "pass", problems: [] },
  fix: { verdict: "fix", problems: ["State the exact amount before sending."] },
  block: { verdict: "block", problems: ["The recipient looks wrong."] },
  contradictory: { verdict: "pass", problems: ["Wrong recipient"] },
};

const server = http.createServer((req, res) => {
  // Read the body without logging it; it may hold resident content.
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    if (req.method !== "POST" || req.url !== "/check") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (
      requireToken !== "" &&
      req.headers.authorization !== `Bearer ${requireToken}`
    ) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (body === '{"warm":true}') {
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ warming: true }));
      return;
    }
    if (mode === "error") {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "stand-in error" }));
      return;
    }
    const answer = () => {
      if (mode === "slow") {
        return JSON.stringify({ ...VERDICTS.pass, ...META });
      }
      if (mode === "bad-json") {
        return "this is not json";
      }
      if (mode === "dup-keys") {
        return '{"verdict":"pass","problems":[],"verdict":"pass"}';
      }
      return JSON.stringify({ ...(VERDICTS[mode] ?? VERDICTS.pass), ...META });
    };
    const send = () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(answer());
    };
    if (mode === "slow") {
      setTimeout(send, delayMs);
      return;
    }
    send();
  });
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const actual = typeof address === "object" && address ? address.port : port;
  console.log(`STANDIN_READY http://127.0.0.1:${actual}/check`);
});
