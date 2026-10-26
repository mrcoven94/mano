export function getCallerPersonId(request: Request): string | null {
  const header = request.headers.get("x-person-id");
  if (header) return header;
  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length);
  return null;
}

export function authorizePerson(request: Request, personId: string): Response | null {
  const caller = getCallerPersonId(request);
  if (!caller || caller !== personId) {
    return Response.json({ error: "Forbidden: you can only reach your own agent." }, { status: 403 });
  }
  return null;
}
