import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

function matches(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function POST(req: Request) {
  const expected = process.env.QUALITY_STAFF_TOKEN ?? "";
  if (!expected) return NextResponse.json({ ok: false }, { status: 503 });
  let token = "";
  try {
    token = String((await req.json()).token ?? "");
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  if (!token || !matches(token, expected)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const jar = await cookies();
  jar.set("mano_staff", expected, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/quality",
    maxAge: 60 * 60 * 8,
  });
  return NextResponse.json({ ok: true });
}
