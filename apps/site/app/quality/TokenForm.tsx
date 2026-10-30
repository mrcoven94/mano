"use client";

import { useState } from "react";

export default function TokenForm() {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const res = await fetch("/quality/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (res.ok) window.location.reload();
    else setError("That token did not work.");
  }

  return (
    <form onSubmit={submit} style={{ maxWidth: 420, display: "grid", gap: 12 }}>
      <p>Staff only. Enter your quality token to see the numbers.</p>
      <label style={{ display: "grid", gap: 6, fontSize: ".92rem" }}>
        Token
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoComplete="off"
          style={{ minHeight: 46, padding: "0 14px", borderRadius: 12, border: "1px solid var(--border2)", font: "inherit" }}
        />
      </label>
      {error ? <p role="alert" style={{ color: "var(--alert)" }}>{error}</p> : null}
      <button type="submit" className="btn btn-primary" style={{ justifySelf: "start" }}>Show quality</button>
    </form>
  );
}
