// One decision for every route: signed-out people see the sign-in
// screen, wherever they were. The entry route and the auth screens
// redirect themselves, so the gate leaves those alone.

export type GuardStatus = "loading" | "signed-out" | "signed-in";

export function sessionRouteGuard(status: GuardStatus, rootSegment: string | undefined): "stay" | "sign-in" {
  if (status !== "signed-out") return "stay";
  if (rootSegment === "(auth)" || rootSegment === undefined) return "stay";
  return "sign-in";
}
