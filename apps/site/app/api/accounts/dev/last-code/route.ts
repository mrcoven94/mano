import { NextResponse } from "next/server";
import { RecordingChannels } from "@mano/accounts";
import { accounts } from "@/lib/accounts-server";

// Dev only: read the last phone code the stand-in recorded, so a developer
// can sign in with a synthetic number locally. 404 unless development with
// stand-in channels. Never enabled live.
export async function GET() {
  if (process.env.NODE_ENV === "production") return new NextResponse("Not found.", { status: 404 });
  const { channels, live } = accounts();
  if (live.channels !== "stand-in") return new NextResponse("Not found.", { status: 404 });
  if (!(channels instanceof RecordingChannels)) return new NextResponse("Not found.", { status: 404 });
  const last = channels.sends[channels.sends.length - 1];
  if (!last) return NextResponse.json({ code: null });
  const match = last.message.match(/(\d{6})/);
  return NextResponse.json({ code: match ? match[1] : null });
}
