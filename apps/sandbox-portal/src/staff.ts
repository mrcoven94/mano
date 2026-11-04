// The caseworker's screen: cases residents shared with the one test office,
// read live from Engine's staff routes on every view, so a revoke shows at
// the next click. The portal stores none of it.
//
// Staff sign in with the portal's access token, which sets a signed cookie.
// Engine turns that same token into a short staff session for the sandbox
// org and no other, so this page can never open another organization.
import type { PortalConfig } from "./app";
import { escapeHtml, layout } from "./pages";

const STAFF_COOKIE = "mano_staff";
const SIGN_IN_MS = 8 * 3600_000;
const ENGINE_TIMEOUT_MS = 10_000;
const MAX_FORM_BYTES = 4096;

const OFFICE = "Sandbox County Human Services (test office)";

const COOKIE_BREAK = /;\s*/;
const HEX_SIGNATURE = /^[0-9a-f]{64}$/;
const BYTE_PAIR = /../g;
const STAFF_CASE_PATH = /^\/staff\/cases\/([^/]+)(\/requests|\/documents\/[^/]+)?$/;

const encoder = new TextEncoder();

function page(title: string, body: string, status = 200, headers?: HeadersInit): Response {
  return new Response(layout(title, body), {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

async function cookieKey(token: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signedIn(request: Request, token: string, nowMs: number): Promise<boolean> {
  const cookie = (request.headers.get("cookie") ?? "").split(COOKIE_BREAK).find((c) => c.startsWith(`${STAFF_COOKIE}=`));
  const [expires, signature] = (cookie?.slice(STAFF_COOKIE.length + 1) ?? "").split(".");
  if (!expires || !signature || !HEX_SIGNATURE.test(signature) || !(Number(expires) > nowMs)) return false;
  const bytes = Uint8Array.from(signature.match(BYTE_PAIR)!, (h) => parseInt(h, 16));
  return crypto.subtle.verify("HMAC", await cookieKey(token), bytes, encoder.encode(`staff:${expires}`));
}

async function signInCookie(request: Request, token: string, nowMs: number): Promise<string> {
  const expires = String(nowMs + SIGN_IN_MS);
  const signature = toHex(await crypto.subtle.sign("HMAC", await cookieKey(token), encoder.encode(`staff:${expires}`)));
  return `${STAFF_COOKIE}=${expires}.${signature}; ${cookieAttributes(request)}; Max-Age=${SIGN_IN_MS / 1000}`;
}

function cookieAttributes(request: Request): string {
  return `Path=/staff; HttpOnly; SameSite=Strict${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
}

async function sameBytes(a: string, b: string): Promise<boolean> {
  const hash = async (s: string) => toHex(await crypto.subtle.digest("SHA-256", encoder.encode(s)));
  return (await hash(a)) === (await hash(b));
}

async function readForm(request: Request): Promise<URLSearchParams | null> {
  const text = await request.text();
  if (encoder.encode(text).length > MAX_FORM_BYTES) return null;
  return new URLSearchParams(text);
}

function signInPage(error?: string): Response {
  return page(
    "Staff sign-in",
    `<h2>Staff sign-in: ${escapeHtml(OFFICE)}</h2>
${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
<form method="post" action="/staff/sign-in">
<table class="form"><tr><td class="label"><label for="password">Staff access token</label></td><td><input type="password" id="password" name="password" autocomplete="current-password" style="width:280px"></td></tr></table>
<p><button class="btn" type="submit">Sign in</button></p>
</form>`,
    error ? 401 : 200,
  );
}

const ENGINE_DOWN = () =>
  page("Try again", `<div class="error">Mano's records could not be reached, so nothing is shown and nothing was sent. Try again in a moment.</div><p><a href="/staff">Back to shared cases</a></p>`, 503);

const NOT_SHARED = () =>
  page("Not shared", `<div class="error">This case is not shared with this office. The resident may have stopped sharing it.</div><p><a href="/staff">Back to shared cases</a></p>`, 404);

interface EngineCase {
  caseId: string;
  purpose: string;
  sharedAt: string;
  details: { label: string; value: string }[];
  requests: { id: string; label: string; status: string; requestedAt: string }[];
  documents: { id: string; name: string; label: string; providedAt: string }[];
  requestableKinds: Record<string, string>;
}

function caseListPage(cases: { caseId: string; purpose: string; sharedAt: string }[]): Response {
  const rows = cases
    .map((c) => `<tr><td><a href="/staff/cases/${encodeURIComponent(c.caseId)}">${escapeHtml(c.caseId)}</a></td><td>${escapeHtml(c.purpose)}</td><td>${escapeHtml(c.sharedAt)}</td></tr>`)
    .join("");
  return page(
    "Shared cases",
    `<h2>Cases shared with ${escapeHtml(OFFICE)}</h2>
${cases.length > 0 ? `<table class="form"><tr><td class="label">Case</td><td class="label">Shared for</td><td class="label">Shared at</td></tr>${rows}</table>` : "<p>No resident is sharing a case with this office right now.</p>"}
${signOutForm()}`,
  );
}

function signOutForm(): string {
  return `<form method="post" action="/staff/sign-out"><p><button class="btn" type="submit">Sign out</button></p></form>`;
}

function caseDetailPage(view: EngineCase): Response {
  const id = encodeURIComponent(view.caseId);
  const details = view.details.map((d) => `<tr><td class="label">${escapeHtml(d.label)}</td><td>${escapeHtml(d.value)}</td></tr>`).join("");
  const requests = view.requests.map((r) => `<tr><td class="label">${escapeHtml(r.label)}</td><td>${escapeHtml(r.status)}, asked ${escapeHtml(r.requestedAt)}</td></tr>`).join("");
  const documents = view.documents
    .map((d) => `<tr><td class="label">${escapeHtml(d.label)}</td><td><a href="/staff/cases/${id}/documents/${encodeURIComponent(d.id)}">${escapeHtml(d.name)}</a>, sent ${escapeHtml(d.providedAt)}</td></tr>`)
    .join("");
  const options = Object.entries(view.requestableKinds).map(([kind, label]) => `<option value="${escapeHtml(kind)}">${escapeHtml(label)}</option>`).join("");
  return page(
    "Shared case",
    `<h2>Case ${escapeHtml(view.caseId)}</h2>
<p>Shared by the resident through Mano, with their approval, for ${escapeHtml(view.purpose)}, on ${escapeHtml(view.sharedAt)}. This is all the resident shared.</p>
<table class="form">${details}</table>
<h3>Documents the resident sent</h3>
${documents ? `<table class="form">${documents}</table>` : "<p>None yet.</p>"}
<h3>What this office asked for</h3>
${requests ? `<table class="form">${requests}</table>` : "<p>Nothing yet.</p>"}
<form method="post" action="/staff/cases/${id}/requests">
<input type="hidden" name="key" value="${crypto.randomUUID()}">
<p><label for="documentKind">Ask the resident for</label> <select id="documentKind" name="documentKind">${options}</select> <button class="btn" type="submit">Send request</button></p>
</form>
<p><a href="/staff">Back to shared cases</a></p>`,
  );
}

export async function staffRoute(request: Request, path: string, method: string, config: PortalConfig): Promise<Response> {
  const { portalToken: token, engineUrl, sandboxOrgId: orgId } = config;
  if (!token || !engineUrl || !orgId) {
    return page("Not configured", `<div class="error">The staff view is not configured on this portal.</div>`, 503);
  }
  const now = config.now?.() ?? Date.now();
  // The cookie is SameSite=Strict; this also refuses a form posted from
  // another site by a browser that ignores it.
  const origin = request.headers.get("origin");
  if (method === "POST" && origin && origin !== new URL(request.url).origin) return page("Refused", `<div class="error">Refused.</div>`, 403);

  if (path === "/staff/sign-in" && method === "POST") {
    const password = (await readForm(request))?.get("password") ?? "";
    if (!(await sameBytes(password, token))) return signInPage("That token is not right.");
    return new Response(null, { status: 303, headers: { location: "/staff", "set-cookie": await signInCookie(request, token, now), "cache-control": "no-store" } });
  }
  if (!(await signedIn(request, token, now))) {
    return path === "/staff" && method === "GET" ? signInPage() : new Response(null, { status: 303, headers: { location: "/staff", "cache-control": "no-store" } });
  }
  if (path === "/staff/sign-out" && method === "POST") {
    return new Response(null, { status: 303, headers: { location: "/staff", "set-cookie": `${STAFF_COOKIE}=; ${cookieAttributes(request)}; Max-Age=0`, "cache-control": "no-store" } });
  }

  const send = config.engineFetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const engine = async (engineMethod: string, route: string, body?: unknown): Promise<Response | null> => {
    try {
      const session = await send(`${engineUrl}/api/staff/session`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ orgId }),
        signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS),
      });
      if (!session.ok) return null;
      const { token: staff } = (await session.json()) as { token: string };
      return await send(`${engineUrl}/api/orgs/${encodeURIComponent(orgId)}${route}`, {
        method: engineMethod,
        headers: { authorization: `Bearer ${staff}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS),
      });
    } catch {
      return null;
    }
  };

  if (path === "/staff" && method === "GET") {
    const res = await engine("GET", "/cases");
    if (!res?.ok) return ENGINE_DOWN();
    return caseListPage(((await res.json()) as { cases: { caseId: string; purpose: string; sharedAt: string }[] }).cases);
  }
  const match = STAFF_CASE_PATH.exec(path);
  if (match) {
    const caseRoute = `/cases/${match[1]}`;
    const sub = match[2] ?? "";
    if (sub === "" && method === "GET") {
      const res = await engine("GET", caseRoute);
      if (res?.status === 404) return NOT_SHARED();
      if (!res?.ok) return ENGINE_DOWN();
      return caseDetailPage(((await res.json()) as { case: EngineCase }).case);
    }
    if (sub === "/requests" && method === "POST") {
      const form = await readForm(request);
      const res = await engine("POST", `${caseRoute}/document-requests`, { documentKind: form?.get("documentKind"), idempotencyKey: form?.get("key") });
      if (res?.status === 404) return NOT_SHARED();
      if (res?.status === 400) return page("Not sent", `<div class="error">That request could not be sent.</div><p><a href="/staff/cases/${match[1]}">Back to the case</a></p>`, 400);
      if (!res?.ok) return ENGINE_DOWN();
      return new Response(null, { status: 303, headers: { location: `/staff/cases/${match[1]}`, "cache-control": "no-store" } });
    }
    if (sub.startsWith("/documents/") && method === "GET") {
      const res = await engine("GET", `${caseRoute}${sub}`);
      if (res?.status === 404) return NOT_SHARED();
      if (!res?.ok) return ENGINE_DOWN();
      return new Response(res.body, {
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": res.headers.get("content-disposition") ?? "attachment",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }
  }
  return page("Not found", `<div class="error">That page does not exist.</div><p><a href="/staff">Back to shared cases</a></p>`, 404);
}
