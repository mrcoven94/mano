import { NextResponse } from "next/server";
import { OAUTH_STATE_COOKIE, issueOAuthChallenge, originAllowed } from "@mano/accounts";
import { SESSION_COOKIE, accounts, accountsPepper, oauthCookieOptions } from "@/lib/accounts-server";

function cookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export async function POST(request: Request) {
  // The start must come from the site itself. A cross-site POST cannot
  // plant a login in the victim's browser.
  if (!originAllowed(request.url, request.headers.get("origin"), request.headers.get("referer"))) {
    return NextResponse.json({ error: "Email sign-in failed." }, { status: 403 });
  }
  try {
    const body = (await request.json().catch(() => ({}))) as { provider?: unknown };
    const provider = body.provider === "GoogleOAuth" ? "GoogleOAuth" : "authkit";
    const { service, live } = accounts();
    if (live.workos === "stand-in") {
      return NextResponse.json({ error: "Email sign-in needs WorkOS keys. Phone sign-in works now." }, { status: 503 });
    }
    // Caller state is ignored: the server generates state bound to this
    // browser, this session (or its absence), and the linking intent, plus
    // a PKCE challenge. The signed challenge rides in a Secure cookie.
    const sessionToken = cookieValue(request.headers.get("cookie"), SESSION_COOKIE);
    const challenge = await issueOAuthChallenge({ sessionToken, pepper: accountsPepper() });
    const url = service.startEmailSignIn(challenge.state, provider, { codeChallenge: challenge.codeChallenge });
    const res = NextResponse.json({ url });
    res.cookies.set(OAUTH_STATE_COOKIE, challenge.cookieValue, oauthCookieOptions());
    return res;
  } catch (err) {
    if ((err as Error).message === "Accounts are not configured.") {
      return NextResponse.json({ error: "Sign-in is not configured." }, { status: 503 });
    }
    return NextResponse.json({ error: "Email sign-in failed." }, { status: 500 });
  }
}
