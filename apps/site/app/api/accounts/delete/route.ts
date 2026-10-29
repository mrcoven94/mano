import { NextResponse } from "next/server";
import { DeleteIncompleteError } from "@mano/accounts";
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
  } catch (err) {
    // A partial delete is a saved, retryable job, not a sign-out.
    if (err instanceof DeleteIncompleteError) {
      return NextResponse.json(
        { error: (err as Error).message, jobId: err.jobId, retryable: true },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: "Signed out." }, { status: 401 });
  }
}
