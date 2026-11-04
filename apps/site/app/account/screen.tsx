"use client";

import { useCallback, useEffect, useState } from "react";
import { SMS_HREF, SMS_NUMBER } from "@/lib/site";

interface MaskedIdentity {
  id: string;
  kind: "phone" | "email" | "workos";
  masked: string;
  verified: boolean;
}

interface ThreadItem {
  id: string;
  role: "user" | "assistant";
  content: string;
  channel: "text" | "web" | "app";
  createdAt: string;
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {
    throw new Error("Could not reach Mano. Check your connection and try again.");
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; jobId?: unknown };
  if (!res.ok) {
    const err = new Error(data.error || "Request failed.") as Error & { jobId?: string };
    if (typeof data.jobId === "string") err.jobId = data.jobId;
    throw err;
  }
  return data;
}

export default function AccountScreen() {
  const [identities, setIdentities] = useState<MaskedIdentity[] | null>(null);
  const [thread, setThread] = useState<ThreadItem[]>([]);
  const [error, setError] = useState("");
  const [phone, setPhone] = useState("");
  const [phoneCode, setPhoneCode] = useState("");
  /* Set when the server asks for a fresh code before removing this phone. */
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeCode, setRemoveCode] = useState("");
  const [mergePhone, setMergePhone] = useState("");
  const [mergeCode, setMergeCode] = useState("");
  const [mergePreview, setMergePreview] = useState<{
    previewId: string;
    preview: { confirmText: string };
    idempotencyKey: string;
  } | null>(null);

  const load = useCallback(async () => {
    try {
      const account = await post<{ identities: MaskedIdentity[] }>("/api/accounts/get", {});
      setIdentities(account.identities);
      const res = await fetch("/api/accounts/thread");
      if (res.ok) setThread((await res.json()) as ThreadItem[]);
    } catch {
      window.location.href = "/sign-in";
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function addPhone() {
    setError("");
    try {
      const account = await post<{ identities: MaskedIdentity[] }>("/api/accounts/phone/add", {
        phone,
        code: phoneCode,
      });
      setIdentities(account.identities);
      setPhone("");
      setPhoneCode("");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function requestCode(target: string) {
    setError("");
    try {
      await post("/api/accounts/phone/request", { phone: target });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function removeIdentity(identity: MaskedIdentity) {
    setError("");
    try {
      const account = await post<{ identities: MaskedIdentity[] }>("/api/accounts/identity/remove", {
        identityId: identity.id,
        phoneCode: removing === identity.id ? removeCode : undefined,
      });
      setIdentities(account.identities);
      setRemoving(null);
      setRemoveCode("");
    } catch (err) {
      const message = (err as Error).message;
      if (identity.kind === "phone" && removing !== identity.id && message.includes("fresh code")) setRemoving(identity.id);
      else setError(message);
    }
  }

  async function startMergePreview() {
    setError("");
    setMergePreview(null);
    try {
      const proof = await post<{ ownerPersonId: string; samePerson: boolean }>(
        "/api/accounts/phone/verify-for-session",
        { phone: mergePhone, code: mergeCode },
      );
      if (proof.samePerson) {
        setError("That number is already on this account.");
        return;
      }
      const preview = await post<{ previewId: string; preview: { confirmText: string } }>(
        "/api/accounts/merge/preview",
        { fromPersonId: proof.ownerPersonId },
      );
      // One key per preview: retries and double taps merge once.
      setMergePreview({ ...preview, idempotencyKey: crypto.randomUUID() });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function confirmMerge(confirmed: boolean) {
    if (!mergePreview) return;
    setError("");
    try {
      const account = await post<{ identities: MaskedIdentity[] }>("/api/accounts/merge/confirm", {
        previewId: mergePreview.previewId,
        confirmed,
        idempotencyKey: mergePreview.idempotencyKey,
      });
      setIdentities(account.identities);
      setMergePreview(null);
      setMergePhone("");
      setMergeCode("");
      void load();
    } catch (err) {
      setError((err as Error).message);
      setMergePreview(null);
    }
  }

  async function signOut() {
    setError("");
    try {
      await post("/api/accounts/sign-out-everywhere", {});
      window.location.href = "/sign-in";
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function deleteAccount() {
    const ok = window.confirm("Delete your Mano account, thread and documents? This cannot be undone.");
    if (!ok) return;
    setError("");
    try {
      await post("/api/accounts/delete", {});
      window.location.href = "/";
    } catch (err) {
      // A partial delete is saved server-side and safe to retry.
      const message = (err as Error).message;
      if (message.includes("retry")) {
        const retry = window.confirm("Delete did not finish. It is saved. Try again now?");
        if (!retry) return;
        const res = await fetch("/api/accounts/delete/retry", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jobId: (err as { jobId?: string }).jobId ?? "" }),
        });
        if (res.ok) {
          window.location.href = "/";
          return;
        }
      }
      setError(message);
    }
  }

  async function addEmail() {
    setError("");
    try {
      const res = await fetch("/api/accounts/email/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "authkit" }),
      });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        setError(data.error || "Email is not ready yet.");
        return;
      }
      window.location.href = data.url;
    } catch {
      setError("Could not reach Mano. Check your connection and try again.");
    }
  }

  if (!identities) return <p>Loading…</p>;

  return (
    <div>
      {error ? <div className="acct-error" role="alert">{error}</div> : null}
      <div className="acct-card">
        <h2>Sign-in methods</h2>
        <p>Masked here. Removing the last one is not allowed.</p>
        <ul className="acct-list">
          {identities.map((identity) => (
            <li key={identity.id}>
              <span>
                <span className="acct-kind">{identity.kind}</span>
                {identity.masked}
              </span>
              {removing !== identity.id ? (
                <button className="btn btn-ghost btn-sm" onClick={() => removeIdentity(identity)}>
                  Remove
                </button>
              ) : null}
              {removing === identity.id ? (
                <div className="acct-remove">
                  <p>To get a code, type this number under Add a phone and tap Text a code.</p>
                  <div className="acct-field">
                    <label htmlFor="remove-code">Confirm with a code sent to this phone</label>
                    <input
                      id="remove-code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="123456"
                      value={removeCode}
                      onChange={(e) => setRemoveCode(e.target.value)}
                    />
                  </div>
                  <div className="acct-row">
                    <button className="btn btn-danger btn-sm" onClick={() => removeIdentity(identity)} disabled={removeCode.trim().length < 6}>
                      Remove phone
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => { setRemoving(null); setRemoveCode(""); }}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
      <div className="acct-card">
        <h2>Add a phone</h2>
        <p>We text a code to confirm the number first.</p>
        <div className="acct-field">
          <label htmlFor="add-phone">Phone number</label>
          <input id="add-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div className="acct-field">
          <label htmlFor="add-code">Code</label>
          <input id="add-code" inputMode="numeric" value={phoneCode} onChange={(e) => setPhoneCode(e.target.value)} />
        </div>
        <div className="acct-row">
          <button className="btn btn-ghost" onClick={() => requestCode(phone)} disabled={!phone.trim()}>
            Text a code
          </button>
          <button className="btn btn-primary" onClick={addPhone} disabled={!phone.trim() || phoneCode.trim().length < 6}>
            Add phone
          </button>
          <button className="btn btn-ghost" onClick={addEmail}>
            Add email
          </button>
        </div>
      </div>
      <div className="acct-card">
        <h2>Combine accounts</h2>
        <p>Texted first and signed up by email later? Confirm the other number, read what will be combined, then confirm.</p>
        <div className="acct-field">
          <label htmlFor="merge-phone">Other phone number</label>
          <input id="merge-phone" type="tel" value={mergePhone} onChange={(e) => setMergePhone(e.target.value)} />
        </div>
        <div className="acct-field">
          <label htmlFor="merge-code">Code sent to that number</label>
          <input id="merge-code" inputMode="numeric" value={mergeCode} onChange={(e) => setMergeCode(e.target.value)} />
        </div>
        <div className="acct-row">
          <button className="btn btn-ghost" onClick={() => requestCode(mergePhone)} disabled={!mergePhone.trim()}>
            Text a code
          </button>
          <button className="btn btn-primary" onClick={startMergePreview} disabled={!mergePhone.trim() || mergeCode.trim().length < 6}>
            Preview combine
          </button>
        </div>
        {mergePreview ? (
          <div className="acct-merge">
            <p>{mergePreview.preview.confirmText}</p>
            <div className="acct-row" style={{ marginTop: 12 }}>
              <button className="btn btn-primary" onClick={() => confirmMerge(true)}>
                Combine
              </button>
              <button className="btn btn-ghost" onClick={() => confirmMerge(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </div>
      <div className="acct-card">
        <h2>Thread</h2>
        <p>The same conversation on text, the web and the app.</p>
        {thread.length === 0 ? (
          <p className="note">No messages yet. Text Mano at <a className="sms-num" href={SMS_HREF}>{SMS_NUMBER}</a> to start.</p>
        ) : (
          <ul className="acct-thread">
            {thread.map((item) => (
              <li key={item.id}>
                <span className="mono">{item.channel} · {item.role}</span>
                {item.content}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="acct-card acct-danger">
        <h2>Sessions and data</h2>
        <div className="acct-row">
          <button className="btn btn-ghost" onClick={signOut}>
            Sign out everywhere
          </button>
          <button className="btn btn-danger" onClick={deleteAccount}>
            Delete account
          </button>
        </div>
      </div>
    </div>
  );
}
