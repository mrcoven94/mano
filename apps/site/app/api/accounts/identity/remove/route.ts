import { NextResponse } from "next/server";
import { accounts } from "@/lib/accounts-server";
import { sessionFrom } from "../../_session";

export async function POST(request: Request) {
  const token = sessionFrom(request);
  if (!token) return NextResponse.json({ error: "Signed out." }, { status: 401 });
  try {
    const body = (await request.json().catch(() => ({}))) as { identityId?: unknown; phoneCode?: unknown };
    if (typeof body.identityId !== "string") {
      return NextResponse.json({ error: "Pick an identity." }, { status: 400 });
    }
    const { service } = accounts();
    const view = await service.removeIdentity(
      token,
      body.identityId,
      typeof body.phoneCode === "string" ? body.phoneCode : undefined,
    );
    return NextResponse.json(view);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
