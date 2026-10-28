import { describe, expect, test, vi } from "vitest";
import { ModalComputer } from "../src/modal";

function service(responses: Record<string, { status: number; body: unknown }>) {
  const calls: Array<{ url: string; init?: unknown }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: unknown) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    const found = responses[path] ?? { status: 404, body: { error: "no route" } };
    const body = found.body instanceof Uint8Array ? found.body : JSON.stringify(found.body);
    return new Response(body, { status: found.status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("modal desktop client", () => {
  const routes = {
    "/sessions": { status: 200, body: { id: "sess-1", live_view_url: "https://live.test/sess-1" } },
    "/sessions/sess-1/screenshot": { status: 200, body: new Uint8Array([137, 80, 78, 71]) },
    "/sessions/sess-1/act": { status: 200, body: { applied: 1 } },
    "/sessions/sess-1/goto": { status: 200, body: {} },
    "/sessions/sess-1/stage": { status: 200, body: { path: "/uploads/a.pdf" } },
    "/sessions/sess-1": { status: 200, body: {} },
  };

  test("starts one session lazily and drives it", async () => {
    const { fetchImpl, calls } = service(routes);
    const computer = new ModalComputer({ baseUrl: "https://computer.test", profile: "maria", width: 1280, height: 800, fetchImpl });
    expect(computer.liveViewUrl()).toBeNull();
    await computer.goto("https://portal.test/apply");
    const shot = await computer.screenshot();
    expect(shot[0]).toBe(137);
    await computer.act([{ type: "click", button: "left", x: 1, y: 2 }]);
    const path = await computer.stageFile("a.pdf", new TextEncoder().encode("%PDF-a"));
    expect(path).toBe("/uploads/a.pdf");
    expect(computer.liveViewUrl()).toBe("https://live.test/sess-1");
    const posts = calls.filter((c) => (c.init as { method?: string } | undefined)?.method === "POST");
    expect(posts.map((c) => new URL(c.url).pathname)).toEqual(["/sessions", "/sessions/sess-1/goto", "/sessions/sess-1/act", "/sessions/sess-1/stage"]);
    const created = JSON.parse((posts[0]?.init as { body: string }).body) as Record<string, unknown>;
    expect(created).toMatchObject({ profile: "maria", width: 1280, height: 800 });
    const staged = JSON.parse((posts[3]?.init as { body: string }).body) as Record<string, unknown>;
    expect(staged["name"]).toBe("a.pdf");
    expect(Buffer.from(staged["data_base64"] as string, "base64").toString()).toBe("%PDF-a");
    await computer.close();
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    const last = calls[calls.length - 1];
    expect(new URL(last?.url ?? "").pathname).toBe("/sessions/sess-1");
    expect((last?.init as { method?: string })?.method).toBe("DELETE");
    await computer.close();
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  test("a failing service surfaces errors", async () => {
    const { fetchImpl } = service({ "/sessions": { status: 500, body: { error: "down" } } });
    const computer = new ModalComputer({ baseUrl: "https://computer.test", profile: "maria", fetchImpl });
    await expect(computer.screenshot()).rejects.toThrow("status 500");
    await computer.close();
  });

  test("use after close throws", async () => {
    const { fetchImpl } = service(routes);
    const computer = new ModalComputer({ baseUrl: "https://computer.test", profile: "maria", fetchImpl });
    await computer.close();
    await expect(computer.goto("https://portal.test")).rejects.toThrow("closed");
  });
});
