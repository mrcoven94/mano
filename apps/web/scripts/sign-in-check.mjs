// Proves a deployed copy end to end from a maintainer's machine: requests
// a code (a real email goes to CHECK_EMAIL), computes the same code from
// the grant secret instead of reading the inbox, opens a session and runs
// one chat turn. Prints statuses and the reply, never a code or a token.
//
//   WEB_URL=https://... CHECK_EMAIL=you@example.org MANO_HANDLE_GRANT_SECRET=... node apps/web/scripts/sign-in-check.mjs
//   CHECK_MESSAGE sets the message. SKIP_EMAIL=1 mints a session directly, for
//   checking chat before email sending is turned on.

import { createHmac } from "node:crypto";

const base = process.env.WEB_URL?.replace(/\/$/, "");
const email = process.env.CHECK_EMAIL?.trim().toLowerCase();
const secret = process.env.MANO_HANDLE_GRANT_SECRET;
const pepper = process.env.MANO_HANDLE_PEPPER;
if (!base || !email || !secret) throw new Error("Set WEB_URL, CHECK_EMAIL and MANO_HANDLE_GRANT_SECRET.");

const derive = (label) => createHmac("sha256", secret).update(`mano-web:${label}:v1`).digest();
const post = (path, body, token) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

async function openSession() {
  if (process.env.SKIP_EMAIL === "1") {
    if (!pepper) throw new Error("SKIP_EMAIL needs MANO_HANDLE_PEPPER.");
    const hash = createHmac("sha256", pepper).update(`mano-handle:v1:web-email:${email}`).digest("hex");
    const iat = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(JSON.stringify({ sub: `handle-${hash}`, iat, exp: iat + 600 })).toString("base64url");
    const mac = createHmac("sha256", derive("session")).update(`w1.${payload}`).digest("base64url");
    console.log("session minted locally, email step skipped");
    return { token: `w1.${payload}.${mac}`, personId: `handle-${hash}` };
  }
  const asked = await post("/api/auth/request-code", { email });
  console.log("request-code", asked.status);
  if (!asked.ok) throw new Error(`request-code answered ${asked.status}`);
  const { challengeId } = await asked.json();
  const mac = createHmac("sha256", derive("code")).update(`${challengeId}:${email}`).digest();
  const code = String(mac.readUInt32BE(0) % 1_000_000).padStart(6, "0");
  const opened = await post("/api/auth/verify-code", { email, challengeId, code });
  console.log("verify-code", opened.status);
  if (!opened.ok) throw new Error(`verify-code answered ${opened.status}`);
  return opened.json();
}

const session = await openSession();
const message = process.env.CHECK_MESSAGE ?? "Hi Mano. What can you help me with?";
const started = Date.now();
const turn = await post(`/api/persons/${session.personId}/chat`, { message, clientOpId: `check-${started}` }, session.token);
console.log("chat", turn.status, `${Date.now() - started}ms`);
console.log((await turn.json()).reply ?? "(no reply)");
const thread = await fetch(`${base}/api/persons/${session.personId}/conversation`, { headers: { authorization: `Bearer ${session.token}` } });
console.log("conversation", thread.status, (await thread.json()).messages?.length, "messages");
const gap = await fetch(`${base}/api/persons/${session.personId}/approvals`, { headers: { authorization: `Bearer ${session.token}` } });
console.log("approvals", gap.status);
