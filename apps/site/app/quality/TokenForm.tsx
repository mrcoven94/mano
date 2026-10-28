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
    <form onSubmit={submit} style={{ maxWidth: 420 }}>
      <p>Staff only. Enter your quality token to see the numbers.</p>
      <label style={{ display: "block", marginBottom: 8 }}>
        Token
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoComplete="off"
          style={{ display: "block", width: "100%", marginTop: 4, padding: 8 }}
        />
      </label>
      {error ? <p role="alert">{error}</p> : null}
      <button type="submit">Show quality</button>
    </form>
  );
}
