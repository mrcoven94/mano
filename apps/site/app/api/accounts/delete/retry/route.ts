import { NextResponse } from "next/server";
import { DeleteIncompleteError } from "@mano/accounts";
import { SESSION_COOKIE, accounts } from "@/lib/accounts-server";
import { sessionFrom } from "../../_session";

// Retry a delete that did not finish. The unguessable job ID authorizes the
// retry; when the browser still holds the session it must match the job.
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { jobId?: unknown };
    if (typeof body.jobId !== "string" || !body.jobId) {
      return NextResponse.json({ error: "Delete job not found." }, { status: 404 });
    }
    const { service } = accounts();
    await service.retryDeleteAccount(body.jobId, sessionFrom(request) ?? undefined);
    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
    return res;
  } catch (err) {
    if (err instanceof DeleteIncompleteError) {
      return NextResponse.json(
        { error: (err as Error).message, jobId: err.jobId, retryable: true },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
