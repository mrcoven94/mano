import { NextResponse } from "next/server";
import { accounts } from "@/lib/accounts-server";
import { sessionFrom } from "../../_session";

export async function POST(request: Request) {
  const token = sessionFrom(request);
  if (!token) return NextResponse.json({ error: "Signed out." }, { status: 401 });
  try {
    const body = (await request.json().catch(() => ({}))) as { fromPersonId?: unknown };
    if (typeof body.fromPersonId !== "string") {
      return NextResponse.json({ error: "Pick an account." }, { status: 400 });
    }
    const { service } = accounts();
    return NextResponse.json(await service.previewMerge(token, body.fromPersonId));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
