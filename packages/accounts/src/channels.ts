// Channels port: the narrow seam between accounts and the text line.
// Production sends phone codes over Mano's own iMessage line through the
// Channels Worker's service binding, and deletes the Channels
// conversation when an account is deleted. Never log the handle or code.

export interface ChannelsPort {
  // Send a sign-in code. Message text is fixed in codes.ts.
  sendCode(toE164: string, message: string): Promise<void>;
  // Delete every Channels-side conversation row for a person.
  deleteConversationsForPerson(personId: string): Promise<{ deleted: number }>;
}

export class RecordingChannels implements ChannelsPort {
  sends: { toE164: string; message: string }[] = [];
  deletes: string[] = [];

  async sendCode(toE164: string, message: string): Promise<void> {
    this.sends.push({ toE164, message });
  }

  async deleteConversationsForPerson(personId: string): Promise<{ deleted: number }> {
    this.deletes.push(personId);
    return { deleted: 1 };
  }
}

// Service binding shape the Channels Worker exposes. The Worker keeps one
// Durable Object per hashed handle; accounts reaches it only through these
// two internal routes, never the provider directly.
export interface ChannelsServiceBinding {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

export class BindingChannels implements ChannelsPort {
  private binding: ChannelsServiceBinding;

  constructor(binding: ChannelsServiceBinding) {
    this.binding = binding;
  }

  async sendCode(toE164: string, message: string): Promise<void> {
    const res = await this.binding.fetch("https://channels/internal/send-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: toE164, message }),
    });
    if (!res.ok) throw new Error("Code send failed.");
  }

  async deleteConversationsForPerson(personId: string): Promise<{ deleted: number }> {
    const res = await this.binding.fetch("https://channels/internal/delete-person", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ personId }),
    });
    if (!res.ok) throw new Error("Conversation delete failed.");
    return (await res.json()) as { deleted: number };
  }
}

// Live Channels client for callers without a service binding (the site on
// Vercel). Same two routes over HTTPS with a server-to-server credential
// (MANO_CHANNELS_KEY). Base URL and key arrive from config, never code.
export class HttpChannels implements ChannelsPort {
  readonly live = true;
  private baseUrl: string;
  private apiKey: string;
  private fetchFn: typeof fetch;

  constructor(baseUrl: string, apiKey: string, fetchFn: typeof fetch = fetch) {
    if (!baseUrl || !apiKey) throw new Error("Accounts are not configured.");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.fetchFn = fetchFn;
  }

  async sendCode(toE164: string, message: string): Promise<void> {
    const res = await this.fetchFn(`${this.baseUrl}/internal/send-code`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ to: toE164, message }),
    });
    if (!res.ok) throw new Error("Code send failed.");
  }

  async deleteConversationsForPerson(personId: string): Promise<{ deleted: number }> {
    const res = await this.fetchFn(`${this.baseUrl}/internal/delete-person`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ personId }),
    });
    if (!res.ok) throw new Error("Conversation delete failed.");
    return (await res.json()) as { deleted: number };
  }
}
