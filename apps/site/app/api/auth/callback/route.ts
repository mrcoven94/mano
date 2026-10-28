import { NextResponse } from "next/server";
import { SESSION_COOKIE, accounts, sessionCookieOptions } from "@/lib/accounts-server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = request.headers.get("cookie")?.match(/mano-oauth-state=([^;]+)/)?.[1];
  if (!code || !state || !expected || decodeURIComponent(expected) !== state) {
    return NextResponse.redirect(new URL("/sign-in?error=auth", url));
  }
  try {
    const { service } = accounts();
    const existing = request.headers.get("cookie")?.match(/mano-session=([^;]+)/)?.[1];
    const sessionToken = existing ? decodeURIComponent(existing) : undefined;
    const signed = await service.completeEmailSignIn(code, sessionToken);
    void signed;
    const res = NextResponse.redirect(new URL("/account", url));
    if (!sessionToken) {
      res.cookies.set(SESSION_COOKIE, signed.sessionToken, sessionCookieOptions());
    }
    res.cookies.set("mano-oauth-state", "", { path: "/", maxAge: 0 });
    return res;
  } catch {
    return NextResponse.redirect(new URL("/sign-in?error=auth", url));
  }
}
