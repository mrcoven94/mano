// A stand-in dev server for agent-stack tests: listens on --port, spawns a
// long-lived grandchild (as wrangler spawns workerd), and records both pids.
// With --hang it accepts connections and never answers, and ignores SIGTERM.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const hang = process.argv.includes("--hang");
const pidFile = process.env.FAKE_PID_FILE;
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
if (pidFile) appendFileSync(pidFile, `${process.pid}\n${child.pid}\n`);
if (hang) process.on("SIGTERM", () => {});
createServer((_req, res) => {
  if (hang) return;
  res.end("ok");
}).listen(port, "127.0.0.1");
