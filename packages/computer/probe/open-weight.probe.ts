import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runLoop } from "../src/loop";
import { MODAL_MODEL_ID, OPEN_WEIGHT_MODEL_ID, OpenWeightModelClient } from "../src/open-weight";
import { PlaywrightComputer } from "../src/playwright";

// With both Modal settings the same probe runs on a Modal Shared Endpoint.
const modalUrl = process.env["MODAL_ENDPOINT_URL"] || undefined;
const apiKey = (modalUrl ? process.env["MODAL_PROXY_TOKEN"] : process.env["OPENROUTER_API_KEY"]) ?? "";

if (!apiKey) console.log("probe:live open-weight computer skipped: no key for its route.");

// A synthetic person, and the fields of the sandbox portal's first step.
const VALUES: Record<string, [string, string]> = {
  caseNumber: ["Case number", "WA-SNAP-0042117"],
  fullName: ["Full legal name", "Rosa Testcase"],
  address: ["Mailing address", "100 Sample St, Tacoma, WA 98402"],
  phone: ["Phone number", "253-555-0142"],
  householdSize: ["People in household", "3"],
  monthlyIncome: ["Monthly income ($)", "2329"],
};

const rows = Object.entries(VALUES).map(([name, [label]]) => `<tr><td>${label}</td><td><input type="text" name="${name}" size="40"></td></tr>`);
const FORM = `<h1>Step 1 of 3: Household</h1><form method="post" action="/saved"><table>${rows.join("")}</table><p><button>Continue to Step 2</button></p></form>`;

// The one question the docs cannot answer: does this model read a screen and
// put its clicks on the right pixels? Passing means every value landed in its
// own field and the form moved on.
describe.skipIf(!apiKey)("the open-weight model drives a computer, live", () => {
  let server: Server;
  let saved: URLSearchParams | null = null;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.method !== "POST") return void res.writeHead(200, { "content-type": "text/html" }).end(FORM);
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        saved = new URLSearchParams(data);
        res.writeHead(200, { "content-type": "text/html" }).end("<h1>Step 2 of 3: Documents</h1>");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  afterAll(() => {
    server.close();
  });

  it("fills a synthetic form and continues", async () => {
    const computer = new PlaywrightComputer();
    const started = performance.now();
    try {
      await computer.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
      const lines = Object.values(VALUES).map(([label, value]) => `${label}: ${value}`);
      const task = ["Fill out the form open in this browser with exactly these values, then continue to the next step.", ...lines, "When the next step appears, stop and reply with exactly: ACCEPTED"].join("\n");
      const outcome = await runLoop(computer, new OpenWeightModelClient({ apiKey, modalUrl }), task, {
        model: modalUrl ? MODAL_MODEL_ID : OPEN_WEIGHT_MODEL_ID,
        maxSteps: 25,
        // A shorter line for this one-screen form. The agent's fill sends
        // FILL_INSTRUCTIONS (src/form-fill.ts), which is not this text.
        instructions: "These fields do not depend on each other: fill all of them in one batch of click and type actions, then click Continue.",
        onTurn: (turn) => console.log(`turn ${turn.step}: ${"call" in turn ? turn.call.map((a) => a.type).join(",") : "replied"}`),
      });
      console.log(`open-weight computer probe: ${outcome.status}, ${outcome.steps} turns, ${Math.round(performance.now() - started)} ms`);
      expect(outcome.status).toBe("done");
      expect(Object.fromEntries(Object.keys(VALUES).map((name) => [name, saved?.get(name)]))).toEqual(Object.fromEntries(Object.entries(VALUES).map(([name, [, value]]) => [name, value])));
    } finally {
      await computer.close();
    }
  });
});
