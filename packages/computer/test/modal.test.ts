import { describe, expect, test, vi } from "vitest";
import { computerFromEnv } from "../src/index";
import { ModalComputer } from "../src/modal";

const SECRET = "synthetic-session-secret";

function service(deleteStatuses: Array<number | "network"> = [200]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const deletes = [...deleteStatuses];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init ? { init } : {}) });
    const parsed = new URL(url);
    const key = `${parsed.host}${parsed.pathname}`;
    if (key === "computer.test/sessions" && init?.method === "POST") {
      return new Response(JSON.stringify({ id: "sess-1", control_url: "https://control.test/", session_secret: SECRET }), { status: 200 });
    }
    if (key === "computer.test/sessions/sess-1" && init?.method === "DELETE") {
      const next = deletes.length > 1 ? deletes.shift()! : deletes[0]!;
      if (next === "network") throw new TypeError("fetch failed");
      return new Response(JSON.stringify({}), { status: next });
    }
    if (key === "control.test/screenshot") return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 });
    if (key === "control.test/act") return new Response(JSON.stringify({ applied: 1 }), { status: 200 });
    if (key === "control.test/goto") return new Response(JSON.stringify({}), { status: 200 });
    if (key === "control.test/stage") return new Response(JSON.stringify({ path: "/uploads/a.pdf" }), { status: 200 });
    return new Response(JSON.stringify({ error: "no route" }), { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const header = (call: { init?: RequestInit } | undefined) => new Headers(call?.init?.headers).get("authorization");

function computer(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof ModalComputer>[0]> = {}) {
  return new ModalComputer({ baseUrl: "https://computer.test", personId: "person-a", token: "service-token", fetchImpl, retryDelaysMs: [0, 0, 0], ...extra });
}

describe("modal desktop client", () => {
  test("starts one session lazily and drives it through the control URL", async () => {
    const { fetchImpl, calls } = service();
    const desktop = computer(fetchImpl, { width: 1280, height: 800 });
    await desktop.goto("https://portal.test/apply");
    const shot = await desktop.screenshot();
    expect(shot[0]).toBe(137);
    await desktop.act([{ type: "click", button: "left", x: 1, y: 2 }]);
    const path = await desktop.stageFile("a.pdf", new TextEncoder().encode("%PDF-a"));
    expect(path).toBe("/uploads/a.pdf");
    expect(calls.map((c) => c.url)).toEqual([
      "https://computer.test/sessions",
      "https://control.test/goto",
      "https://control.test/screenshot",
      "https://control.test/act",
      "https://control.test/stage",
    ]);
    const created = JSON.parse(calls[0]?.init?.body as string) as Record<string, unknown>;
    expect(created).toEqual({ person_id: "person-a", width: 1280, height: 800 });
    const staged = JSON.parse(calls[4]?.init?.body as string) as Record<string, unknown>;
    expect(staged["name"]).toBe("a.pdf");
    expect(Buffer.from(staged["data_base64"] as string, "base64").toString()).toBe("%PDF-a");
    await desktop.close();
    expect(calls[calls.length - 1]?.url).toBe("https://computer.test/sessions/sess-1");
    expect(calls[calls.length - 1]?.init?.method).toBe("DELETE");
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    await desktop.close();
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  test("there is no live view", async () => {
    const { fetchImpl } = service();
    const desktop = computer(fetchImpl);
    await desktop.screenshot();
    expect(desktop.liveViewUrl()).toBeNull();
    await desktop.close();
  });

  test("a failing service surfaces errors", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: "down" }), { status: 500 })) as unknown as typeof fetch;
    const desktop = computer(fetchImpl);
    await expect(desktop.screenshot()).rejects.toThrow("status 500");
    await desktop.close();
  });

  test("use after close throws", async () => {
    const { fetchImpl } = service();
    const desktop = computer(fetchImpl);
    await desktop.close();
    await expect(desktop.goto("https://portal.test")).rejects.toThrow("closed");
  });

  test("a person id is required", () => {
    expect(() => computer(service().fetchImpl, { personId: "" })).toThrow("person");
    expect(() => computerFromEnv({ COMPUTER_BACKEND: "modal", MODAL_COMPUTER_URL: "https://computer.test" })).toThrow("COMPUTER_PERSON_ID");
  });
});

describe("modal session secrets", () => {
  test("every control call carries the session secret, and only control calls do", async () => {
    const { fetchImpl, calls } = service();
    const desktop = computer(fetchImpl);
    await desktop.goto("https://portal.test/apply");
    await desktop.screenshot();
    await desktop.act([{ type: "wait" }]);
    await desktop.stageFile("a.pdf", new Uint8Array([1]));
    await desktop.close();
    const control = calls.filter((c) => c.url.startsWith("https://control.test/"));
    const session = calls.filter((c) => c.url.startsWith("https://computer.test/"));
    expect(control).toHaveLength(4);
    for (const call of control) expect(header(call)).toBe(`Bearer ${SECRET}`);
    expect(session).toHaveLength(2);
    for (const call of session) expect(header(call)).toBe("Bearer service-token");
  });

  test("a session without a secret is refused", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ id: "sess-1", control_url: "https://control.test/" }), { status: 200 })) as unknown as typeof fetch;
    const desktop = computer(fetchImpl);
    await expect(desktop.screenshot()).rejects.toThrow("no session");
  });
});

describe("modal session teardown", () => {
  test("close retries the delete until the service confirms", async () => {
    const { fetchImpl, calls } = service([502, "network", 200]);
    const desktop = computer(fetchImpl);
    await desktop.screenshot();
    await desktop.close();
    expect(calls.filter((c) => c.init?.method === "DELETE")).toHaveLength(3);
  });

  test("a session the service no longer knows counts as closed", async () => {
    const { fetchImpl, calls } = service([404]);
    const desktop = computer(fetchImpl);
    await desktop.screenshot();
    await desktop.close();
    expect(calls.filter((c) => c.init?.method === "DELETE")).toHaveLength(1);
  });

  test("close gives up after bounded retries and says so", async () => {
    const { fetchImpl, calls } = service([502]);
    const desktop = computer(fetchImpl);
    await desktop.screenshot();
    await expect(desktop.close()).rejects.toThrow("sess-1");
    expect(calls.filter((c) => c.init?.method === "DELETE")).toHaveLength(4);
  });

  test("close during startup still deletes the session it started", async () => {
    const { fetchImpl, calls } = service();
    const desktop = computer(fetchImpl);
    const pending = desktop.screenshot().catch((err: unknown) => err);
    await desktop.close();
    expect(await pending).toBeInstanceOf(Error);
    expect(calls.filter((c) => c.init?.method === "DELETE").map((c) => c.url)).toEqual(["https://computer.test/sessions/sess-1"]);
  });
});
