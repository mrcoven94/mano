// Stand-in for the guardian model endpoint. Speaks just enough of the
// OpenAI chat completions API to exercise GlimmerChecker locally with no GPU
// and no keys. Scripted by flags; request bodies are never logged.
//
// Usage:
//   node standin/server.mjs [--port N] [--mode pass|fix|block|bad-json|error|slow]
//     [--require-token TOKEN] [--delay-ms N]
//
// Prints "STANDIN_READY <url>" on stdout once listening.
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

const VERDICTS = {
  pass: { verdict: "pass", problems: [] },
  fix: { verdict: "fix", problems: ["State the exact amount before sending."] },
  block: { verdict: "block", problems: ["The recipient looks wrong."] },
};

const server = http.createServer((req, res) => {
  // Drain the body without logging it; it may hold resident content.
  req.resume();
  req.on("end", () => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
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
    if (mode === "error") {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "stand-in error" }));
      return;
    }
    if (mode === "slow") {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(VERDICTS.pass) } }],
          }),
        );
      }, delayMs);
      return;
    }
    const content =
      mode === "bad-json" ? "this is not json" : JSON.stringify(VERDICTS[mode] ?? VERDICTS.pass);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const actual = typeof address === "object" && address ? address.port : port;
  console.log(`STANDIN_READY http://127.0.0.1:${actual}`);
});
