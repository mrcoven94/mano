import { NextResponse } from "next/server";
import { accounts } from "@/lib/accounts-server";
import { sessionFrom } from "../../_session";

export async function POST(request: Request) {
  const token = sessionFrom(request);
  if (!token) return NextResponse.json({ error: "Signed out." }, { status: 401 });
  try {
    const body = (await request.json().catch(() => ({}))) as { phone?: unknown; code?: unknown };
    if (typeof body.phone !== "string" || typeof body.code !== "string") {
      return NextResponse.json({ error: "Enter a phone number and the code sent to it." }, { status: 400 });
    }
    const { service } = accounts();
    return NextResponse.json(await service.addPhone(token, body.phone, body.code));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
