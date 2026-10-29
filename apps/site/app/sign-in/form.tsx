"use client";

import { useState } from "react";

export default function SignInForm() {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);

  async function requestCode() {
    setBusy(true);
    setError("");
    try {
      await fetch("/api/accounts/phone/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      setSent(true);
    } catch {
      setSent(true);
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/accounts/phone/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone, code }),
      });
      if (!res.ok) {
        setError("That code did not match. Check the text and try again.");
        return;
      }
      window.location.href = "/account";
    } finally {
      setBusy(false);
    }
  }

  async function startEmail(provider: "authkit" | "GoogleOAuth") {
    setEmailBusy(true);
    setError("");
    try {
      // The server generates the login state. The client sends none.
      const res = await fetch("/api/accounts/email/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        setError(data.error || "Email sign-in is not ready yet. Phone sign-in works now.");
        return;
      }
      window.location.href = data.url;
    } finally {
      setEmailBusy(false);
    }
  }

  return (
    <div>
      {error ? <div className="acct-error" role="alert">{error}</div> : null}
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
          />
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
              />
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
      </div>
      <p className="note">New here? Text Mano first. That creates your account, then sign in here with the same number.</p>
    </div>
  );
}
