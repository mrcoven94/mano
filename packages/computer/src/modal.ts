import type { ComputerAction } from "./actions";
import type { Computer, ComputerOptions } from "./computer";

export interface ModalComputerOptions extends ComputerOptions {
  /** Session service base URL, from the modal/ app deploy. */
  baseUrl: string;
  /** Person the browser profile belongs to. Profiles live in a Modal volume. */
  profile: string;
  fetchImpl?: typeof fetch;
}

/**
 * Hosted desktop behind the session service in modal/. One Sandbox per run,
 * reusing the person's browser profile; the service stops it when idle.
 */
export class ModalComputer implements Computer {
  private sessionId: string | null = null;
  private starting: Promise<string> | null = null;
  private viewUrl: string | null = null;
  private baseUrl: string;
  private fetchImpl: typeof fetch;
  private closed = false;

  constructor(private options: ModalComputerOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async session(): Promise<string> {
    if (this.closed) throw new Error("computer is closed");
    if (this.sessionId) return this.sessionId;
    if (!this.starting) {
      this.starting = this.post("/sessions", {
        profile: this.options.profile,
        width: this.options.width ?? 1280,
        height: this.options.height ?? 800,
      }).then((body) => {
        const parsed = body as { id?: unknown; live_view_url?: unknown };
        if (typeof parsed.id !== "string") throw new Error("session service returned no session");
        this.sessionId = parsed.id;
        this.viewUrl = typeof parsed.live_view_url === "string" ? parsed.live_view_url : null;
        return parsed.id;
      });
    }
    return this.starting;
  }

  async screenshot(): Promise<Uint8Array> {
    const id = await this.session();
    const res = await this.fetchImpl(`${this.baseUrl}/sessions/${id}/screenshot`);
    if (!res.ok) throw new Error(`screenshot failed with status ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async act(actions: ComputerAction[]): Promise<void> {
    const id = await this.session();
    const res = await this.fetchImpl(`${this.baseUrl}/sessions/${id}/act`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actions }),
    });
    if (!res.ok) throw new Error(`actions failed with status ${res.status}`);
  }

  async goto(url: string): Promise<void> {
    const id = await this.session();
    await this.post(`/sessions/${id}/goto`, { url });
  }

  async stageFile(name: string, data: Uint8Array): Promise<string> {
    const id = await this.session();
    const body = (await this.post(`/sessions/${id}/stage`, { name, data_base64: Buffer.from(data).toString("base64") })) as { path?: unknown };
    if (typeof body.path !== "string") throw new Error("session service returned no path");
    return body.path;
  }

  liveViewUrl(): string | null {
    return this.viewUrl;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.starting = null;
    if (this.sessionId) {
      const id = this.sessionId;
      this.sessionId = null;
      await this.fetchImpl(`${this.baseUrl}/sessions/${id}`, { method: "DELETE" }).catch(() => undefined);
    }
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`session service ${path} failed with status ${res.status}`);
    return (await res.json()) as unknown;
  }
}
