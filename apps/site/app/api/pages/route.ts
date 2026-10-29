import { handleAgentRevoke, handleCreate } from "@mano/pages";
import { pagesDeps } from "@/lib/pages-server";

export async function POST(req: Request) {
  const raw = await req.text();
  const deps = pagesDeps(new URL(req.url).origin);
  try {
    const out = await handleCreate(raw, req.headers.get("mano-signature"), req.headers.get("idempotency-key"), deps);
    return Response.json(out, { status: out.status });
  } catch (err) {
    console.error(`[pages] create failed: ${err instanceof Error ? err.message : "unknown"}`);
    return Response.json({ status: 503, error: "page links are having trouble" }, { status: 503 });
  }
}

export async function DELETE(req: Request) {
  const raw = await req.text();
  const deps = pagesDeps(new URL(req.url).origin);
  try {
    const out = await handleAgentRevoke(raw, req.headers.get("mano-signature"), deps);
    return Response.json(out, { status: out.status });
  } catch (err) {
    console.error(`[pages] revoke failed: ${err instanceof Error ? err.message : "unknown"}`);
    return Response.json({ status: 503, error: "page links are having trouble" }, { status: 503 });
  }
}
