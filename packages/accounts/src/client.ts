// Typed client for the App session (LAP-519) and the web.
// Sign-in screens contract, versioned. Screens call these methods and
// nothing else. The App owns its files; this client is the seam.
//
// Flow A, phone: requestPhoneCode -> verifyPhoneCode -> getThread.
// Flow B, email: startEmailSignIn (open URL) -> completeEmailSignIn(code).
// Linking: addPhone, completeEmailSignIn with a session.
// Merge: previewMerge shows preview.confirmText exactly, then confirmMerge.
// Account: getAccount, removeIdentity, signOutEverywhere, deleteAccount.

export const ACCOUNTS_CLIENT_VERSION = "v1";

export interface SignInResult {
  personId: string;
  sessionToken: string;
}

export interface AccountsClient {
  requestPhoneCode(phone: string): Promise<{ ok: true }>;
  verifyPhoneCode(phone: string, code: string): Promise<SignInResult>;
  // State is optional: the server generates and binds it. A caller value is ignored.
  startEmailSignIn(state?: string, provider?: "authkit" | "GoogleOAuth"): Promise<{ url: string }>;
  completeEmailSignIn(code: string, sessionToken?: string): Promise<SignInResult & { linked: boolean }>;
  verifyPhoneForSession(
    sessionToken: string,
    phone: string,
    code: string,
  ): Promise<{ ownerPersonId: string; samePerson: boolean }>;
  addPhone(sessionToken: string, phone: string, code: string): Promise<import("./types").AccountView>;
  getAccount(sessionToken: string): Promise<import("./types").AccountView>;
  removeIdentity(
    sessionToken: string,
    identityId: string,
    phoneCode?: string,
  ): Promise<import("./types").AccountView>;
  previewMerge(
    sessionToken: string,
    fromPersonId: string,
  ): Promise<{ previewId: string; preview: import("./types").MergePreview }>;
  confirmMerge(
    sessionToken: string,
    previewId: string,
    confirmed: boolean,
    idempotencyKey?: string,
  ): Promise<import("./types").AccountView>;
  signOutEverywhere(sessionToken: string): Promise<void>;
  deleteAccount(sessionToken: string): Promise<void>;
  retryDeleteAccount(jobId: string, sessionToken?: string): Promise<void>;
  getThread(sessionToken: string): Promise<
    { id: string; role: "user" | "assistant"; content: string; channel: "text" | "web" | "app"; createdAt: string }[]
  >;
}

// HTTP client against the accounts routes. Base URL holds no secrets.
export class HttpAccountsClient implements AccountsClient {
  private baseUrl: string;
  private fetchFn: typeof fetch;

  constructor(baseUrl: string, fetchFn: typeof fetch = fetch) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetchFn = fetchFn;
  }

  private async call<T>(path: string, body: Record<string, unknown>, sessionToken?: string): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (sessionToken) headers.authorization = `Bearer ${sessionToken}`;
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || "Request failed.");
    }
    return (await res.json()) as T;
  }

  async requestPhoneCode(phone: string): Promise<{ ok: true }> {
    return this.call<{ ok: true }>("/accounts/phone/request", { phone });
  }

  async verifyPhoneCode(phone: string, code: string): Promise<SignInResult> {
    return this.call<SignInResult>("/accounts/phone/verify", { phone, code });
  }

  async startEmailSignIn(state?: string, provider: "authkit" | "GoogleOAuth" = "authkit"): Promise<{ url: string }> {
    return this.call<{ url: string }>("/accounts/email/start", { provider, ...(state ? { state } : {}) });
  }

  async completeEmailSignIn(code: string, sessionToken?: string): Promise<SignInResult & { linked: boolean }> {
    return this.call<SignInResult & { linked: boolean }>("/accounts/email/complete", { code }, sessionToken);
  }

  async verifyPhoneForSession(sessionToken: string, phone: string, code: string) {
    return this.call<{ ownerPersonId: string; samePerson: boolean }>(
      "/accounts/phone/verify-for-session",
      { phone, code },
      sessionToken,
    );
  }

  async addPhone(sessionToken: string, phone: string, code: string) {
    return this.call<import("./types").AccountView>("/accounts/phone/add", { phone, code }, sessionToken);
  }

  async getAccount(sessionToken: string) {
    return this.call<import("./types").AccountView>("/accounts/get", {}, sessionToken);
  }

  async removeIdentity(sessionToken: string, identityId: string, phoneCode?: string) {
    return this.call<import("./types").AccountView>(
      "/accounts/identity/remove",
      { identityId, phoneCode },
      sessionToken,
    );
  }

  async previewMerge(sessionToken: string, fromPersonId: string) {
    return this.call<{ previewId: string; preview: import("./types").MergePreview }>(
      "/accounts/merge/preview",
      { fromPersonId },
      sessionToken,
    );
  }

  async confirmMerge(sessionToken: string, previewId: string, confirmed: boolean, idempotencyKey?: string) {
    return this.call<import("./types").AccountView>(
      "/accounts/merge/confirm",
      { previewId, confirmed, ...(idempotencyKey ? { idempotencyKey } : {}) },
      sessionToken,
    );
  }

  async signOutEverywhere(sessionToken: string): Promise<void> {
    await this.call<{ ok: true }>("/accounts/sign-out-everywhere", {}, sessionToken);
  }

  async deleteAccount(sessionToken: string): Promise<void> {
    await this.call<{ ok: true }>("/accounts/delete", {}, sessionToken);
  }

  async retryDeleteAccount(jobId: string, sessionToken?: string): Promise<void> {
    await this.call<{ ok: true }>("/accounts/delete/retry", { jobId }, sessionToken);
  }

  async getThread(sessionToken: string) {
    const headers: Record<string, string> = { authorization: `Bearer ${sessionToken}` };
    const res = await this.fetchFn(`${this.baseUrl}/accounts/thread`, { headers });
    if (!res.ok) throw new Error("Request failed.");
    return (await res.json()) as {
      id: string;
      role: "user" | "assistant";
      content: string;
      channel: "text" | "web" | "app";
      createdAt: string;
    }[];
  }
}
