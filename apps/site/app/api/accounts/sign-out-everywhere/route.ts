import { NextResponse } from "next/server";
import { SESSION_COOKIE, accounts } from "@/lib/accounts-server";
import { sessionFrom } from "../_session";

export async function POST(request: Request) {
  const token = sessionFrom(request);
  if (!token) return NextResponse.json({ ok: true });
  try {
    const { service } = accounts();
    await service.signOutEverywhere(token);
  } catch {
    // Signing out always clears the cookie, even when the session is stale.
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
