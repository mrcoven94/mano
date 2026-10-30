import { describe, expect, test, vi } from "vitest";
import { ModalComputer } from "../src/modal";

function service() {
  const calls: Array<{ url: string; init?: unknown }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: unknown) => {
    calls.push({ url, init });
    const parsed = new URL(url);
    const key = `${parsed.host}${parsed.pathname}`;
    if (key === "computer.test/sessions" && (init as { method?: string })?.method === "POST") {
      return new Response(JSON.stringify({ id: "sess-1", control_url: "https://control.test/", live_view_url: "https://live.test/sess-1" }), { status: 200 });
    }
    if (key === "control.test/screenshot") return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 });
    if (key === "control.test/act") return new Response(JSON.stringify({ applied: 1 }), { status: 200 });
    if (key === "control.test/goto") return new Response(JSON.stringify({}), { status: 200 });
    if (key === "control.test/stage") return new Response(JSON.stringify({ path: "/uploads/a.pdf" }), { status: 200 });
    if (key === "computer.test/sessions/sess-1") return new Response(JSON.stringify({}), { status: 200 });
    return new Response(JSON.stringify({ error: "no route" }), { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("modal desktop client", () => {
  test("starts one session lazily and drives it through the control URL", async () => {
    const { fetchImpl, calls } = service();
    const computer = new ModalComputer({ baseUrl: "https://computer.test", profile: "maria", width: 1280, height: 800, fetchImpl });
    expect(computer.liveViewUrl()).toBeNull();
    await computer.goto("https://portal.test/apply");
    const shot = await computer.screenshot();
    expect(shot[0]).toBe(137);
    await computer.act([{ type: "click", button: "left", x: 1, y: 2 }]);
    const path = await computer.stageFile("a.pdf", new TextEncoder().encode("%PDF-a"));
    expect(path).toBe("/uploads/a.pdf");
    expect(computer.liveViewUrl()).toBe("https://live.test/sess-1");
    const urls = calls.map((c) => c.url);
    expect(urls).toEqual([
      "https://computer.test/sessions",
      "https://control.test/goto",
      "https://control.test/screenshot",
      "https://control.test/act",
      "https://control.test/stage",
    ]);
    const created = JSON.parse((calls[0]?.init as { body: string }).body) as Record<string, unknown>;
    expect(created).toMatchObject({ profile: "maria", width: 1280, height: 800 });
    const staged = JSON.parse((calls[4]?.init as { body: string }).body) as Record<string, unknown>;
    expect(staged["name"]).toBe("a.pdf");
    expect(Buffer.from(staged["data_base64"] as string, "base64").toString()).toBe("%PDF-a");
    await computer.close();
    expect(calls[calls.length - 1]?.url).toBe("https://computer.test/sessions/sess-1");
    expect((calls[calls.length - 1]?.init as { method?: string })?.method).toBe("DELETE");
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    await computer.close();
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  test("a failing service surfaces errors", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: "down" }), { status: 500 })) as unknown as typeof fetch;
    const computer = new ModalComputer({ baseUrl: "https://computer.test", profile: "maria", fetchImpl });
    await expect(computer.screenshot()).rejects.toThrow("status 500");
    await computer.close();
  });

  test("use after close throws", async () => {
    const { fetchImpl } = service();
    const computer = new ModalComputer({ baseUrl: "https://computer.test", profile: "maria", fetchImpl });
    await computer.close();
    await expect(computer.goto("https://portal.test")).rejects.toThrow("closed");
  });
});

describe("modal session service access", () => {
  test("sends the service token when it opens and closes a session", async () => {
    const { fetchImpl, calls } = service();
    const computer = new ModalComputer({ baseUrl: "https://computer.test", profile: "maria", token: "service-token", fetchImpl });
    await computer.screenshot();
    await computer.close();
    const sessionCalls = calls.filter((c) => c.url.startsWith("https://computer.test/sessions"));
    expect(sessionCalls).toHaveLength(2);
    for (const call of sessionCalls) {
      expect(new Headers((call.init as RequestInit).headers).get("authorization")).toBe("Bearer service-token");
    }
  });
});
