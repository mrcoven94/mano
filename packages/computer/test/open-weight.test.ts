import { describe, expect, test, vi } from "vitest";
import { runLoop } from "../src/loop";
import { MODAL_MODEL_ID, OPEN_WEIGHT_MODEL_ID, OpenWeightModelClient } from "../src/open-weight";
import { FakeComputer, FAKE_PNG } from "./fake-computer";

type Body = { model: string; tools: Array<Record<string, unknown>>; input: Array<Record<string, any>>; store: boolean; provider: unknown; reasoning: unknown; max_output_tokens: number; instructions: string };

const SCREEN = `data:image/png;base64,${Buffer.from(FAKE_PNG).toString("base64")}`;
const fn = (call_id: string, args: unknown, name = "computer") => ({ type: "function_call", id: `fc-${call_id}`, call_id, name, arguments: typeof args === "string" ? args : JSON.stringify(args) });
const say = (text: string) => ({ type: "message", content: [{ type: "output_text", text }] });

function scripted(replies: Array<{ output: unknown[]; status?: string }>) {
  const bodies: Body[] = [];
  const urls: string[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    urls.push(String(input));
    bodies.push(JSON.parse(String(init?.body)) as Body);
    const next = replies.shift();
    if (!next) throw new Error("ran out of replies");
    return Response.json({ id: `r${bodies.length}`, status: next.status ?? "completed", output: next.output });
  }) as typeof fetch;
  return { bodies, urls, client: new OpenWeightModelClient({ apiKey: "k", fetchImpl, retryDelaysMs: [] }) };
}

const run = (client: OpenWeightModelClient, computer = new FakeComputer()) => runLoop(computer, client, "Fill the form.", { model: OPEN_WEIGHT_MODEL_ID });

describe("computer use on the open-weight model", () => {
  test("the model's 0 to 1000 grid becomes pixels on the screen, and its own numbers replay", async () => {
    const computer = new FakeComputer();
    const { client, bodies } = scripted([
      { output: [fn("a", { actions: [{ type: "click", x: 227, y: 98 }, { type: "double_click", x: 500, y: 500 }, { type: "scroll", x: 1000, y: 1000, scroll_y: 300 }] })] },
      { output: [say("ACCEPTED")] },
    ]);

    expect(await run(client, computer)).toEqual({ status: "done", message: "ACCEPTED", steps: 2 });

    // The first click is the Case number field, whose centre on the 1280 by
    // 800 screen is (291, 79): where the live model aimed.
    expect(computer.actions).toEqual([
      [
        { type: "click", button: "left", x: 291, y: 78 },
        { type: "double_click", x: 640, y: 400 },
        { type: "scroll", x: 1279, y: 799, scroll_x: 0, scroll_y: 300 },
      ],
    ]);
    const replayed = (bodies[1]!.input as { type?: string; arguments?: string }[]).find((item) => item.type === "function_call");
    expect(JSON.parse(replayed!.arguments!).actions.slice(0, 2)).toMatchObject([{ x: 227, y: 98 }, { x: 500, y: 500 }]);
    expect(JSON.stringify((bodies[0]!.tools as unknown[])[0])).toContain("0 to 1000");
    expect((bodies[0] as unknown as { instructions: string }).instructions).toContain("grid from 0 to 1000");
    expect((bodies[0] as unknown as { instructions: string }).instructions).not.toContain("Coordinates are pixels");
  });

  test("a scroll with no point scrolls at the middle of the screen, and a scroll with half a point is refused", async () => {
    const { client } = scripted([{ output: [fn("a", { actions: [{ type: "scroll", scroll_y: 300 }] })] }, { output: [say("ACCEPTED")] }]);
    const computer = new FakeComputer();
    await run(client, computer);
    expect(computer.actions[0]).toEqual([{ type: "scroll", x: 640, y: 400, scroll_x: 0, scroll_y: 300 }]);
    const half = scripted([{ output: [fn("a", { actions: [{ type: "scroll", x: 1, scroll_y: 300 }] })] }]);
    await expect(run(half.client)).rejects.toThrow("bad coordinate");
  });

  test("on Modal it sends Modal's model to that endpoint with no pin, and refuses any URL off Modal's domain", async () => {
    for (const modalUrl of ["", "not a url", "https://example.com", "https://x.modal.direct.example.com", "http://a.modal.direct"]) {
      expect(() => new OpenWeightModelClient({ apiKey: "k", modalUrl })).toThrow("Modal");
    }
    const bodies: Body[] = [];
    const urls: string[] = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      urls.push(String(input));
      bodies.push(JSON.parse(String(init?.body)) as Body);
      expect(init?.redirect).toBe("error");
      return Response.json({ id: "r1", status: "completed", output: [say("ACCEPTED")] });
    }) as typeof fetch;
    const client = new OpenWeightModelClient({ apiKey: "wk.ws", modalUrl: "https://a--ep-b-server.us-west.modal.direct/", fetchImpl, retryDelaysMs: [] });
    await runLoop(new FakeComputer(), client, "Fill the form.", { model: MODAL_MODEL_ID });
    expect(urls[0]).toBe("https://a--ep-b-server.us-west.modal.direct/v1/responses");
    expect(bodies[0]!.model).toBe(MODAL_MODEL_ID);
    expect(bodies[0]!.provider).toBeUndefined();
    await expect(runLoop(new FakeComputer(), client, "Fill the form.", { model: OPEN_WEIGHT_MODEL_ID })).rejects.toThrow("open-weight");
  });

  test.each([
    ["triple_click", "triple_click"],
    ["Maria Torres", "other"],
  ])("an action the tool does not have logs %j as %j and still stops the run", async (action, logged) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { client } = scripted([{ output: [fn("a", { actions: [{ type: action, x: 1, y: 1 }] })] }]);
    await expect(run(client)).rejects.toThrow("does not have");
    const line = String(warn.mock.calls[0]?.[0]);
    warn.mockRestore();
    expect(JSON.parse(line)).toEqual({ type: "mano_computer_unknown_action", action: logged });
  });

  test("a run: function calls reach the computer, and every request carries the pin, the model and each screen", async () => {
    const computer = new FakeComputer();
    const { client, bodies, urls } = scripted([
      { output: [{ type: "reasoning", summary: [] }, fn("a", { actions: [{ type: "click", x: 100, y: 500 }, { type: "type", text: "Rosa Testcase" }, { type: "keypress", keys: ["ctrl", "a"] }] })] },
      { output: [fn("b", { actions: [{ type: "scroll", x: 500, y: 250, scroll_y: 300 }, { type: "wait" }] })] },
      { output: [say("ACCEPTED")] },
    ]);

    expect(await run(client, computer)).toEqual({ status: "done", message: "ACCEPTED", steps: 3 });

    expect(computer.actions).toEqual([
      [{ type: "click", button: "left", x: 128, y: 400 }, { type: "type", text: "Rosa Testcase" }, { type: "keypress", keys: ["ctrl", "a"] }],
      [{ type: "scroll", x: 640, y: 200, scroll_x: 0, scroll_y: 300 }, { type: "wait" }],
    ]);
    expect(urls).toEqual(Array(3).fill("https://openrouter.ai/api/v1/responses"));
    for (const body of bodies) {
      expect(body.model).toBe("meta/muse-spark-open");
      expect(body.provider).toEqual({ sort: "latency", zdr: true, data_collection: "deny" });
      expect(body.store).toBe(false);
      expect(body.tools.map((t) => [t.type, t.name])).toEqual([["function", "computer"]]);
    }

    const shape = bodies[2]!.input.map((item) => item.type ?? item.role);
    expect(shape).toEqual(["user", "function_call", "function_call_output", "user", "function_call", "function_call_output", "user"]);
    const images = bodies[2]!.input.flatMap((item) => (item.content ?? []).filter((c: { type: string }) => c.type === "input_image"));
    expect(images).toEqual(Array(3).fill({ type: "input_image", detail: "high", image_url: SCREEN }));
    expect(bodies[2]!.input[1]).toEqual({ type: "function_call", call_id: "a", name: "computer", arguments: expect.stringContaining('"Rosa Testcase"') });
  });

  test("calls made together run as one batch and replay as one call, so none goes unanswered", async () => {
    const computer = new FakeComputer();
    const { client, bodies } = scripted([
      { output: [fn("a", { actions: [{ type: "type", text: "1" }] }), fn("b", { actions: [{ type: "type", text: "2" }] })] },
      { output: [say("ACCEPTED")] },
    ]);
    await run(client, computer);
    expect(computer.actions).toEqual([[{ type: "type", text: "1" }, { type: "type", text: "2" }]]);
    const replayed = bodies[1]!.input.filter((item) => item.type === "function_call" || item.type === "function_call_output");
    expect(replayed.map((item) => [item.type, item.call_id])).toEqual([["function_call", "a"], ["function_call_output", "a"]]);
  });

  test("a call the computer cannot run stops the run before anything acts, and its error repeats none of what the model sent", async () => {
    const cases: unknown[] = [
      fn("a", "{not json Rosa"),
      fn("a", "null"),
      fn("a", { actions: "Rosa" }),
      fn("a", { actions: [{ type: "drag", path: [] }] }),
      fn("a", { actions: [{ type: "click", x: "Rosa", y: 1 }] }),
      fn("a", { actions: [{ type: "type", text: "ok" }, { type: "type" }] }),
      fn("a", { actions: [{ type: "keypress", keys: [] }] }),
      fn("a", { actions: [{ type: "type", text: "Rosa" }] }, "file_the_form"),
    ];
    for (const output of cases) {
      const computer = new FakeComputer();
      const { client } = scripted([{ output: [output] }]);
      const failure = await run(client, computer).catch((err: Error) => err);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).not.toContain("Rosa");
      expect(computer.actions).toEqual([]);
    }
  });

  test("a reply cut off at the output cap never runs", async () => {
    const computer = new FakeComputer();
    const { client } = scripted([{ status: "incomplete", output: [fn("a", { actions: [{ type: "type", text: "half" }] })] }]);
    await expect(run(client, computer)).rejects.toThrow("did not complete");
    expect(computer.actions).toEqual([]);
  });

  test("no other model can be sent, and the pin cannot be overridden by the request", async () => {
    const { client, bodies } = scripted([{ output: [say("hi")] }]);
    await expect(client.createResponse({ model: "not-meta/other", instructions: "", tools: [], input: [], store: false })).rejects.toThrow("Meta");
    expect(bodies).toEqual([]);
    const smuggled = { model: OPEN_WEIGHT_MODEL_ID, instructions: "", tools: [{ type: "computer" }], input: [], store: true, provider: { zdr: false } };
    await client.createResponse(smuggled);
    expect(bodies[0]!.store).toBe(false);
    expect(bodies[0]!.provider).toEqual({ sort: "latency", zdr: true, data_collection: "deny" });
    expect(bodies[0]!.tools.map((t) => t.type)).toEqual(["function"]);
  });

  test("a function result carries no image, so a provider that flattens it to text leaves the model its screen", async () => {
    const { client, bodies } = scripted([{ output: [fn("a", { actions: [{ type: "wait" }] })] }, { output: [say("ACCEPTED")] }]);
    await run(client);
    const result = bodies[1]!.input.find((item) => item.type === "function_call_output")!;
    expect(typeof result.output).toBe("string");
  });

  test("the reviewed escape stops whole: a launcher key in a batch means none of it runs", async () => {
    const computer = new FakeComputer();
    const { client } = scripted([{ output: [fn("a", { actions: [{ type: "keypress", keys: ["alt", "F2"] }, { type: "wait" }, { type: "type", text: "touch /tmp/mano-escape" }, { type: "keypress", keys: ["Enter"] }] })] }]);
    expect(await run(client, computer)).toEqual({ status: "refused", steps: 1 });
    expect(computer.actions).toEqual([]);
  });

  test.each([["failed"], ["cancelled"], ["in_progress"], ["queued"], ["incomplete"], ["unknown"], [undefined]])("a reply with status %s never acts, even with a valid call in it", async (status) => {
    const computer = new FakeComputer();
    const valid = fn("a", { actions: [{ type: "type", text: "x" }] });
    const fetchImpl = (async () => Response.json({ id: "r", ...(status ? { status } : {}), output: [valid] })) as unknown as typeof fetch;
    await expect(run(new OpenWeightModelClient({ apiKey: "k", fetchImpl, retryDelaysMs: [] }), computer)).rejects.toThrow("did not complete");
    expect(computer.actions).toEqual([]);
  });

  test.each(["in_progress", "incomplete", "failed"])("a call item marked %s never acts", async (status) => {
    const computer = new FakeComputer();
    const { client } = scripted([{ output: [{ ...fn("a", { actions: [{ type: "type", text: "x" }] }), status }] }]);
    await expect(run(client, computer)).rejects.toThrow();
    expect(computer.actions).toEqual([]);
  });

  test("a call item marked completed runs, and one with no status runs: OpenRouter's schema leaves that field optional", async () => {
    const computer = new FakeComputer();
    const { client } = scripted([{ output: [{ ...fn("a", { actions: [{ type: "type", text: "x" }] }), status: "completed" }, fn("b", { actions: [{ type: "type", text: "y" }] })] }, { output: [say("ACCEPTED")] }]);
    await run(client, computer);
    expect(computer.actions).toEqual([[{ type: "type", text: "x" }, { type: "type", text: "y" }]]);
  });

  test.each([
    ["no call id", { type: "function_call", name: "computer", arguments: "{}" }],
    ["a numeric call id", { type: "function_call", call_id: 7, name: "computer", arguments: '{"actions":[]}' }],
    ["an empty call id", { type: "function_call", call_id: "", name: "computer", arguments: '{"actions":[]}' }],
  ])("a bad call with %s beside a valid one rejects the whole batch", async (_label, bad) => {
    for (const output of [[fn("a", { actions: [{ type: "type", text: "x" }] }), bad], [bad, fn("a", { actions: [{ type: "type", text: "x" }] })]]) {
      const computer = new FakeComputer();
      const { client } = scripted([{ output }]);
      await expect(run(client, computer)).rejects.toThrow();
      expect(computer.actions).toEqual([]);
    }
  });

  test.each(["computer_call", "shell_call", "local_shell_call", "mcp_call", "custom_tool_call", "web_search_call", "image_generation_call", "something_new"])("an unexpected %s item rejects the reply", async (type) => {
    const computer = new FakeComputer();
    const unexpected = { type, id: "x", call_id: "x", actions: [{ type: "click", button: "right", x: 1, y: 1 }], pending_safety_checks: [], status: "completed" };
    for (const output of [[unexpected], [fn("a", { actions: [{ type: "type", text: "x" }] }), unexpected], [say("ACCEPTED"), unexpected]]) {
      const { client } = scripted([{ output }]);
      await expect(run(client, computer)).rejects.toThrow("does not offer");
      expect(computer.actions).toEqual([]);
    }
  });

  test.each([
    ["a right click", { type: "click", button: "right", x: 1, y: 1 }],
    ["a click off the grid", { type: "click", x: 1001, y: 1 }],
    ["a negative coordinate", { type: "double_click", x: 1, y: -1 }],
    ["a click with no y", { type: "click", x: 1 }],
    ["a runaway scroll", { type: "scroll", x: 1, y: 1, scroll_y: 1_000_000 }],
    ["a move", { type: "move", x: 1, y: 1 }],
    ["a drag", { type: "drag", path: [{ x: 1, y: 1 }] }],
  ])("%s is refused and is never run as something else", async (_label, action) => {
    const computer = new FakeComputer();
    const { client } = scripted([{ output: [fn("a", { actions: [action] })] }]);
    await expect(run(client, computer)).rejects.toThrow();
    expect(computer.actions).toEqual([]);
  });
});
