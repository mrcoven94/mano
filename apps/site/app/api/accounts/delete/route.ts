import { NextResponse } from "next/server";
import { SESSION_COOKIE, accounts } from "@/lib/accounts-server";
import { sessionFrom } from "../_session";

export async function POST(request: Request) {
  const token = sessionFrom(request);
  if (!token) return NextResponse.json({ error: "Signed out." }, { status: 401 });
  try {
    const { service } = accounts();
    await service.deleteAccount(token);
    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
    return res;
  } catch {
    return NextResponse.json({ error: "Signed out." }, { status: 401 });
  }
}
