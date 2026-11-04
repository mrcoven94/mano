"use client";

import { useState } from "react";
import { SMS_HREF, SMS_NUMBER } from "@/lib/site";

type FieldError = { at: "phone" | "code" | "email"; text: string };

const OFFLINE = "Could not reach Mano. Check your connection and try again.";

/* What a failed phone request says, by status. Only a 4xx on the code step means the code was wrong. */
function failure(status: number, wrongCode: string): string {
  if (status === 429) return "Too many tries. Wait a few minutes, then try again.";
  if (status === 503) return "Sign-in is not available right now. Try again later.";
  if (status >= 500) return "Something went wrong on our side. Try again in a minute.";
  return wrongCode;
}

export default function SignInForm() {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FieldError | null>(null);
  const [emailBusy, setEmailBusy] = useState(false);

  async function requestCode() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/accounts/phone/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      if (!res.ok) {
        setError({ at: "phone", text: failure(res.status, "Check the number and try again.") });
        return;
      }
      setSent(true);
    } catch {
      setError({ at: "phone", text: OFFLINE });
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/accounts/phone/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone, code }),
      });
      if (!res.ok) {
        setError({ at: "code", text: failure(res.status, "That code did not match. Check the text and try again.") });
        return;
      }
      window.location.href = "/account";
    } catch {
      setError({ at: "code", text: OFFLINE });
    } finally {
      setBusy(false);
    }
  }

  async function startEmail(provider: "authkit" | "GoogleOAuth") {
    setEmailBusy(true);
    setError(null);
    try {
      // The server generates the login state. The client sends none.
      const res = await fetch("/api/accounts/email/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        setError({ at: "email", text: data.error || "Email sign-in is not ready yet. Phone sign-in works now." });
        return;
      }
      window.location.href = data.url;
    } catch {
      setError({ at: "email", text: OFFLINE });
    } finally {
      setEmailBusy(false);
    }
  }

  return (
    <div>
      <div className="acct-card">
        <h2>Phone</h2>
        <p>We text a 6-digit code. It expires in 10 minutes.</p>
        <div className="acct-field">
          <label htmlFor="signin-phone">Phone number</label>
          <input
            id="signin-phone"
            type="tel"
            autoComplete="tel"
            placeholder="+1 555 010 0111"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            aria-invalid={error?.at === "phone" || undefined}
            aria-describedby={error?.at === "phone" ? "signin-error" : undefined}
          />
          {error?.at === "phone" ? <p id="signin-error" className="acct-field-error" role="alert">{error.text}</p> : null}
        </div>
        {!sent ? (
          <button className="btn btn-primary" onClick={requestCode} disabled={busy || !phone.trim()}>
            {busy ? "Sending…" : "Text me a code"}
          </button>
        ) : (
          <div>
            <div className="acct-ok">If that number has a Mano account, a text is on its way.</div>
            <div className="acct-field">
              <label htmlFor="signin-code">Code</label>
              <input
                id="signin-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                aria-invalid={error?.at === "code" || undefined}
                aria-describedby={error?.at === "code" ? "signin-error" : undefined}
              />
              {error?.at === "code" ? <p id="signin-error" className="acct-field-error" role="alert">{error.text}</p> : null}
            </div>
            <div className="acct-row">
              <button className="btn btn-primary" onClick={verify} disabled={busy || code.trim().length < 6}>
                {busy ? "Checking…" : "Sign in"}
              </button>
              <button className="btn btn-ghost" onClick={requestCode} disabled={busy}>
                Resend
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="acct-card">
        <h2>Email</h2>
        <p>We confirm your email, then sign you in. No password.</p>
        <div className="acct-row">
          <button className="btn btn-ghost" onClick={() => startEmail("authkit")} disabled={emailBusy}>
            Continue with email
          </button>
          <button className="btn btn-ghost" onClick={() => startEmail("GoogleOAuth")} disabled={emailBusy}>
            Continue with Google
          </button>
        </div>
        {error?.at === "email" ? <p className="acct-field-error acct-row-error" role="alert">{error.text}</p> : null}
      </div>
      <p className="note">New here? Text Mano at <a className="sms-num" href={SMS_HREF}>{SMS_NUMBER}</a> first. That creates your account, then sign in here with the same number.</p>
    </div>
  );
}
