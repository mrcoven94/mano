import { NextResponse } from "next/server";
import { accounts } from "@/lib/accounts-server";
import { sessionFrom } from "../../_session";

export async function POST(request: Request) {
  const token = sessionFrom(request);
  if (!token) return NextResponse.json({ error: "Signed out." }, { status: 401 });
  try {
    const body = (await request.json().catch(() => ({}))) as { previewId?: unknown; confirmed?: unknown };
    if (typeof body.previewId !== "string" || typeof body.confirmed !== "boolean") {
      return NextResponse.json({ error: "Confirm the merge." }, { status: 400 });
    }
    const { service } = accounts();
    return NextResponse.json(await service.confirmMerge(token, body.previewId, body.confirmed));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
