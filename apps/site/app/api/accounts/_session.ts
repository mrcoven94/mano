import { SESSION_COOKIE } from "@/lib/accounts-server";

const SESSION_COOKIE_VALUE = new RegExp(`${SESSION_COOKIE}=([^;]+)`);

export function sessionFrom(request: Request): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  const match = cookie.match(SESSION_COOKIE_VALUE);
  return match ? decodeURIComponent(match[1]) : null;
}
