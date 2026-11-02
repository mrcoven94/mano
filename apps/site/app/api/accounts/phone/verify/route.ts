import { NextResponse } from "next/server";
import { SESSION_COOKIE, accounts, sessionCookieOptions } from "@/lib/accounts-server";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { phone?: unknown; code?: unknown };
    if (typeof body.phone !== "string" || typeof body.code !== "string") {
      return NextResponse.json({ error: "Enter the 6-digit code." }, { status: 400 });
    }
    const { service } = accounts();
    const signed = await service.verifyPhoneCode(body.phone, body.code);
    const res = NextResponse.json({ personId: signed.personId });
    res.cookies.set(SESSION_COOKIE, signed.sessionToken, sessionCookieOptions());
    return res;
  } catch (err) {
    const message = (err as Error).message;
    if (message === "Accounts are not configured.") {
      return NextResponse.json({ error: "Sign-in is not configured." }, { status: 503 });
    }
    return NextResponse.json({ error: "That code did not match. Check the text and try again." }, { status: 401 });
  }
}
