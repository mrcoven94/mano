import { handleAction } from "@mano/pages";
import { pagesDeps } from "@/lib/pages-server";

export async function PUT(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const raw = await req.text();
  const deps = pagesDeps(new URL(req.url).origin);
  try {
    const out = await handleAction(token, raw, deps);
    return Response.json(out, { status: out.status });
  } catch (err) {
    console.error(`[pages] action failed: ${err instanceof Error ? err.message : "unknown"}`);
    return Response.json({ status: 503, error: "page links are having trouble" }, { status: 503 });
  }
}
