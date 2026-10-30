import type { ComputerAction } from "./actions";
import type { Computer, ComputerOptions } from "./computer";

export interface ModalComputerOptions extends ComputerOptions {
  /** Session service base URL, from the modal/ app deploy. */
  baseUrl: string;
  /** Engine's id for the person. The service derives the person's own profile volume from it. */
  personId: string;
  /** Bearer token the session service requires (MANO_COMPUTER_TOKEN in its Modal secret). */
  token?: string;
  /** Waits between delete attempts when closing. Defaults to 0.5, 1 and 2 seconds. */
  retryDelaysMs?: number[];
  fetchImpl?: typeof fetch;
}

interface Session {
  id: string;
  controlUrl: string;
  secret: string;
}

const DEFAULT_RETRY_DELAYS_MS = [500, 1000, 2000];

/**
 * Hosted desktop behind the session service in modal/. One Sandbox per run,
 * on the person's own profile volume. Control calls carry the per-session
 * secret the service returned; session calls carry the service token.
 */
export class ModalComputer implements Computer {
  private starting: Promise<Session> | null = null;
  private baseUrl: string;
  private fetchImpl: typeof fetch;
  private closed = false;

  constructor(private options: ModalComputerOptions) {
    if (!options.personId) throw new Error("ModalComputer needs the person's id");
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async session(): Promise<Session> {
    if (this.closed) throw new Error("computer is closed");
    this.starting ??= this.open();
    const session = await this.starting;
    if (this.closed) throw new Error("computer is closed");
    return session;
  }

  private async open(): Promise<Session> {
    const res = await this.fetchImpl(`${this.baseUrl}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.serviceHeaders() },
      body: JSON.stringify({ person_id: this.options.personId, width: this.options.width ?? 1280, height: this.options.height ?? 800 }),
    });
    if (!res.ok) throw new Error(`session service /sessions failed with status ${res.status}`);
    const body = (await res.json()) as { id?: unknown; control_url?: unknown; session_secret?: unknown };
    if (typeof body.id !== "string" || typeof body.control_url !== "string" || typeof body.session_secret !== "string" || !body.session_secret) {
      throw new Error("session service returned no session");
    }
    return { id: body.id, controlUrl: body.control_url.replace(/\/$/, ""), secret: body.session_secret };
  }

  private async control(path: string, body?: unknown): Promise<Response> {
    const { controlUrl, secret } = await this.session();
    const headers: Record<string, string> = { authorization: `Bearer ${secret}` };
    if (body === undefined) return this.fetchImpl(`${controlUrl}${path}`, { headers });
    headers["content-type"] = "application/json";
    return this.fetchImpl(`${controlUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  }

  async screenshot(): Promise<Uint8Array> {
    const res = await this.control("/screenshot");
    if (!res.ok) throw new Error(`screenshot failed with status ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async act(actions: ComputerAction[]): Promise<void> {
    const res = await this.control("/act", { actions });
    if (!res.ok) throw new Error(`actions failed with status ${res.status}`);
  }

  async goto(url: string): Promise<void> {
    const res = await this.control("/goto", { url });
    if (!res.ok) throw new Error(`goto failed with status ${res.status}`);
  }

  async stageFile(name: string, data: Uint8Array): Promise<string> {
    const res = await this.control("/stage", { name, data_base64: Buffer.from(data).toString("base64") });
    if (!res.ok) throw new Error(`stage failed with status ${res.status}`);
    const body = (await res.json()) as { path?: unknown };
    if (typeof body.path !== "string") throw new Error("session service returned no path");
    return body.path;
  }

  fileUploadHint(): string {
    return "To attach a file, press Tab until a file button is focused, then press Enter; type the full staged path into the dialog and press Enter. One file per button; do not pick into a filled button again.";
  }

  liveViewUrl(): string | null {
    return null;
  }

  /** Deletes the session, retrying until the service confirms the desktop stopped. Throws if it never does. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const starting = this.starting;
    this.starting = null;
    const session = starting ? await starting.catch(() => null) : null;
    if (!session) return;
    const delays = this.options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(`${this.baseUrl}/sessions/${session.id}`, { method: "DELETE", headers: this.serviceHeaders() }).catch(() => null);
      if (res && (res.ok || res.status === 404)) return;
      if (res && res.status < 500 && res.status !== 429) throw new Error(`session ${session.id} was not deleted: status ${res.status}`);
      if (attempt >= delays.length) throw new Error(`session ${session.id} was not confirmed stopped after ${attempt + 1} attempts`);
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }

  private serviceHeaders(): Record<string, string> {
    return this.options.token ? { authorization: `Bearer ${this.options.token}` } : {};
  }
}
