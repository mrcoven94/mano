import { NextResponse } from "next/server";
import { OAUTH_STATE_COOKIE, consumeOAuthChallenge } from "@mano/accounts";
import { SESSION_COOKIE, accounts, accountsPepper, sessionCookieOptions } from "@/lib/accounts-server";

function cookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const cookieHeader = request.headers.get("cookie");
  const sessionToken = cookieValue(cookieHeader, SESSION_COOKIE);
  try {
    const { service } = accounts();
    // Verifies the signed challenge, the returned state, the session
    // binding, the linking intent, and the expiry in one step. A planted
    // state or a session swap fails here.
    const challenge = await consumeOAuthChallenge({
      cookieValue: cookieValue(cookieHeader, OAUTH_STATE_COOKIE),
      returnedState: url.searchParams.get("state"),
      sessionToken,
      pepper: accountsPepper(),
    });
    const code = url.searchParams.get("code");
    if (!code) return NextResponse.redirect(new URL("/sign-in?error=auth", url));
    const signed = await service.completeEmailSignIn(
      code,
      sessionToken ?? undefined,
      { codeVerifier: challenge.codeVerifier },
    );
    void signed;
    const res = NextResponse.redirect(new URL("/account", url));
    if (!sessionToken) {
      res.cookies.set(SESSION_COOKIE, signed.sessionToken, sessionCookieOptions());
    }
    res.cookies.set(OAUTH_STATE_COOKIE, "", { path: "/", maxAge: 0 });
    return res;
  } catch (err) {
    const message = (err as Error).message;
    // The email belongs to another person and this browser is signed in:
    // send them to the account page to merge, not back to sign-in.
    if (sessionToken && message.includes("already belongs")) {
      const res = NextResponse.redirect(new URL("/account?merge=review", url));
      res.cookies.set(OAUTH_STATE_COOKIE, "", { path: "/", maxAge: 0 });
      return res;
    }
    return NextResponse.redirect(new URL("/sign-in?error=auth", url));
  }
}
