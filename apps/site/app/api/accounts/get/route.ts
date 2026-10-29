import { NextResponse } from "next/server";
import { accounts } from "@/lib/accounts-server";
import { sessionFrom } from "../_session";

export async function POST(request: Request) {
  const token = sessionFrom(request);
  if (!token) return NextResponse.json({ error: "Signed out." }, { status: 401 });
  try {
    const { service } = accounts();
    return NextResponse.json(await service.getAccount(token));
  } catch {
    return NextResponse.json({ error: "Signed out." }, { status: 401 });
  }
}

export async function GET(request: Request) {
  return POST(request);
}
