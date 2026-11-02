// WorkOS AuthKit front door. Checked against https://workos.com/docs:
// - Hosted sign-in via getAuthorizationUrl equivalent: GET
//   https://api.workos.com/user_management/authorize with client_id,
//   redirect_uri, response_type=code, provider, state.
// - provider 'authkit' runs the hosted page (email Magic Auth 6-digit
//   code plus whatever social logins are enabled). provider
//   'GoogleOAuth' goes straight to Google when enabled cleanly.
// - Exchange via POST https://api.workos.com/user_management/authenticate
//   with grant_type authorization_code, client_id, client_secret, code.
// - Magic Auth codes are 6 digits and expire in 10 minutes. Hosted MFA
//   uses TOTP, not SMS; SMS exists only as US-only standalone MFA second
//   factor, so phone sign-in is Mano's own code (see codes.ts).
// Keys arrive by value here but are named MANO_WORKOS_API_KEY and
// MANO_WORKOS_CLIENT_ID at the edge. Never log them.

export type AuthKitProvider = "authkit" | "GoogleOAuth";

export interface WorkOSConfig {
  apiKey: string;
  clientId: string;
  redirectUri: string;
  baseUrl?: string;
}

export interface WorkOSUser {
  id: string;
  email: string | null;
  emailVerified: boolean;
  firstName: string | null;
  lastName: string | null;
  organizationId: string | null;
}

export interface WorkOSAuthOptions {
  // PKCE S256 challenge for the authorize URL.
  codeChallenge?: string;
  // PKCE verifier for the code exchange. Must match the challenge.
  codeVerifier?: string;
}

export interface WorkOSPort {
  live: boolean;
  authorizationUrl(state: string, provider?: AuthKitProvider, options?: WorkOSAuthOptions): string;
  authenticateWithCode(code: string, options?: WorkOSAuthOptions): Promise<WorkOSUser>;
  getUser(userId: string): Promise<WorkOSUser | null>;
  // Remove the WorkOS-side user when its email leaves the Mano account,
  // so sign-in through that identity fails afterwards. Stand-in removes
  // its local copy; live calls the WorkOS user delete endpoint.
  deleteUser(userId: string): Promise<void>;
}

export function workosConfigured(env: {
  MANO_WORKOS_API_KEY?: string;
  MANO_WORKOS_CLIENT_ID?: string;
  MANO_WORKOS_REDIRECT_URI?: string;
}): boolean {
  return Boolean(env.MANO_WORKOS_API_KEY && env.MANO_WORKOS_CLIENT_ID && env.MANO_WORKOS_REDIRECT_URI);
}

export class FetchWorkOS implements WorkOSPort {
  live = true;
  private config: Required<WorkOSConfig>;
  private fetchFn: typeof fetch;

  constructor(config: WorkOSConfig, fetchFn: typeof fetch = fetch) {
    this.config = { baseUrl: "https://api.workos.com", ...config };
    this.fetchFn = fetchFn;
  }

  authorizationUrl(state: string, provider: AuthKitProvider = "authkit", options?: WorkOSAuthOptions): string {
    const url = new URL(`${this.config.baseUrl}/user_management/authorize`);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("provider", provider);
    url.searchParams.set("state", state);
    if (options?.codeChallenge) {
      url.searchParams.set("code_challenge", options.codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
    }
    return url.toString();
  }

  async authenticateWithCode(code: string, options?: WorkOSAuthOptions): Promise<WorkOSUser> {
    const res = await this.fetchFn(`${this.config.baseUrl}/user_management/authenticate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: this.config.clientId,
        client_secret: this.config.apiKey,
        code,
        ...(options?.codeVerifier ? { code_verifier: options.codeVerifier } : {}),
      }),
    });
    if (!res.ok) throw new Error("WorkOS sign-in failed.");
    const data = (await res.json()) as { user?: Record<string, unknown> };
    return toWorkOSUser(data.user ?? {});
  }

  async getUser(userId: string): Promise<WorkOSUser | null> {
    const res = await this.fetchFn(
      `${this.config.baseUrl}/user_management/users/${encodeURIComponent(userId)}`,
      { headers: { authorization: `Bearer ${this.config.apiKey}` } },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error("WorkOS user lookup failed.");
    return toWorkOSUser((await res.json()) as Record<string, unknown>);
  }

  async deleteUser(userId: string): Promise<void> {
    const res = await this.fetchFn(
      `${this.config.baseUrl}/user_management/users/${encodeURIComponent(userId)}`,
      { method: "DELETE", headers: { authorization: `Bearer ${this.config.apiKey}` } },
    );
    if (res.status === 404) return;
    if (!res.ok) throw new Error("WorkOS user delete failed.");
  }
}

function toWorkOSUser(raw: Record<string, unknown>): WorkOSUser {
  return {
    id: String(raw.id ?? ""),
    email: typeof raw.email === "string" ? raw.email : null,
    emailVerified: raw.email_verified === true,
    firstName: typeof raw.first_name === "string" ? raw.first_name : null,
    lastName: typeof raw.last_name === "string" ? raw.last_name : null,
    organizationId: typeof raw.organization_id === "string" ? raw.organization_id : null,
  };
}

// Stand-in for local runs and tests without WorkOS keys. Prints which
// parts are not live via live=false. Synthetic emails only.
export class StandInWorkOS implements WorkOSPort {
  live = false;
  private users = new Map<string, WorkOSUser>();
  private codes = new Map<string, string>();
  readonly redirectUri: string;

  constructor(redirectUri = "http://localhost:3000/api/auth/callback") {
    this.redirectUri = redirectUri;
  }

  authorizationUrl(state: string, _provider: AuthKitProvider = "authkit", _options?: WorkOSAuthOptions): string {
    void _provider;
    void _options;
    return `${this.redirectUri}?standin=1&state=${encodeURIComponent(state)}`;
  }

  // Test hook: create a user and a one-time code for them.
  addUser(user: WorkOSUser, code: string): void {
    this.users.set(user.id, user);
    this.codes.set(code, user.id);
  }

  async authenticateWithCode(code: string, _options?: WorkOSAuthOptions): Promise<WorkOSUser> {
    void _options;
    const userId = this.codes.get(code);
    if (!userId) throw new Error("WorkOS sign-in failed.");
    this.codes.delete(code);
    const user = this.users.get(userId);
    if (!user) throw new Error("WorkOS sign-in failed.");
    return user;
  }

  async getUser(userId: string): Promise<WorkOSUser | null> {
    return this.users.get(userId) ?? null;
  }

  async deleteUser(userId: string): Promise<void> {
    this.users.delete(userId);
    for (const [code, id] of [...this.codes]) {
      if (id === userId) this.codes.delete(code);
    }
  }
}
