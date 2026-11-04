import { NextResponse } from "next/server";
import { accounts } from "@/lib/accounts-server";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { phone?: unknown };
    if (typeof body.phone !== "string") return NextResponse.json({ ok: true });
    const { service } = accounts();
    // Same response whether or not the phone has an account.
    await service.requestPhoneCode(body.phone);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if ((err as Error).message === "Accounts are not configured.") {
      return NextResponse.json({ error: "Sign-in is not configured." }, { status: 503 });
    }
    // Nothing here depends on whether the phone has an account, so this cannot reveal one.
    return NextResponse.json({ error: "Something went wrong on our side." }, { status: 500 });
  }
}
