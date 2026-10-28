import { NextResponse } from "next/server";
import { accounts } from "@/lib/accounts-server";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { state?: unknown; provider?: unknown };
    const state = typeof body.state === "string" && body.state ? body.state : Math.random().toString(36).slice(2);
    const provider = body.provider === "GoogleOAuth" ? "GoogleOAuth" : "authkit";
    const { service, live } = accounts();
    if (live.workos === "stand-in") {
      return NextResponse.json({ error: "Email sign-in needs WorkOS keys. Phone sign-in works now." }, { status: 503 });
    }
    const url = service.startEmailSignIn(state, provider);
    const res = NextResponse.json({ url });
    res.cookies.set("mano-oauth-state", state, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 600 });
    return res;
  } catch (err) {
    if ((err as Error).message === "Accounts are not configured.") {
      return NextResponse.json({ error: "Sign-in is not configured." }, { status: 503 });
    }
    return NextResponse.json({ error: "Email sign-in failed." }, { status: 500 });
  }
}
