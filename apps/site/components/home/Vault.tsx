"use client";
import { useState } from "react";
import Mascot from "@/components/Mascot";

/* Everything a person has proved goes into one private vault, and every application is filled from it.
   Pick an application to see which things Mano used. Every item here is made up. */

const d = (s: number) => ({ "--d": `${s}s` }) as React.CSSProperties;

const DOCS = [
  { k: "id", name: "Photo ID", from: "Snapped a photo", tint: "#DCE3FB" },
  { k: "pay", name: "Pay stubs", from: "Pulled from payroll", tint: "#CFE3D6" },
  { k: "lease", name: "Lease", from: "Forwarded an email", tint: "#F2EADB" },
  { k: "bill", name: "Utility bill", from: "Snapped a photo", tint: "#FFF4B8" },
  { k: "ssn", name: "SSN or ITIN", from: "Typed once", tint: "#E4E0F5" },
  { k: "home", name: "Who lives with you", from: "Told Mano by text", tint: "#FDE3DA" },
] as const;

type DocKey = (typeof DOCS)[number]["k"];

const APPS: { name: string; office: string; uses: DocKey[] }[] = [
  { name: "Food benefits", office: "Sample County", uses: ["id", "pay", "home", "ssn", "bill"] },
  { name: "Rent help", office: "Sample County", uses: ["id", "pay", "lease", "home"] },
  { name: "Light bill help", office: "Sample Power", uses: ["id", "pay", "bill", "home"] },
  { name: "Health coverage", office: "Sample State", uses: ["id", "pay", "ssn", "home"] },
  { name: "Child care", office: "Northside Family Center", uses: ["id", "pay", "home"] },
];

function Safe({ turn }: { turn: number }) {
  return (
    <svg className="vt-safe" viewBox="0 0 200 200" aria-hidden="true">
      <rect x="22" y="182" width="26" height="12" rx="4" fill="#121212" />
      <rect x="152" y="182" width="26" height="12" rx="4" fill="#121212" />
      <rect x="10" y="22" width="180" height="164" rx="30" fill="#FFFDF9" stroke="#121212" strokeWidth="4" />
      <rect x="4" y="60" width="14" height="24" rx="4" fill="#121212" />
      <rect x="4" y="126" width="14" height="24" rx="4" fill="#121212" />
      <circle cx="104" cy="104" r="64" fill="#FFE14A" stroke="#121212" strokeWidth="4" />
      <g className="vt-dial" style={{ transform: `rotate(${turn * 90}deg)` }}>
        {[0, 90, 180, 270].map((a) => (
          <g key={a} transform={`rotate(${a} 104 104)`}>
            <path d="M104 104V52" stroke="#121212" strokeWidth="6" strokeLinecap="round" />
            <circle cx="104" cy="50" r="8" fill="#FF8F6B" stroke="#121212" strokeWidth="3.5" />
          </g>
        ))}
      </g>
      <circle cx="104" cy="104" r="24" fill="#FFFDF9" stroke="#121212" strokeWidth="4" />
      <circle cx="96" cy="101" r="3" fill="#121212" />
      <circle cx="112" cy="101" r="3" fill="#121212" />
      <path d="M98 110Q104 115 110 110" fill="none" stroke="#121212" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export default function Vault() {
  const [a, setA] = useState(0);
  const app = APPS[a];
  const used = new Set<DocKey>(app.uses);

  return (
    <div className="vt">
      <div className="h-head">
        <h2 id="vt-h">Everything you have proved, in your private vault.</h2>
        <p className="lede">Your ID, pay stubs, lease, utility bills and your Social Security number or ITIN. No SSN or ITIN? Mano helps you prove who you are, where you live, who is in your household and what you earn another way. Snap a photo, forward an email or let Mano pull the record. Mano uses it for every application, so you never dig for the same paper twice.</p>
      </div>

      <div className="vt-stage">
        <div className="vt-col">
          <p className="sc-label">In your vault</p>
          <ul className="vt-docs">
            {DOCS.map((x) => (
              <li key={x.k} className="vt-doc" data-used={used.has(x.k) || undefined} style={{ "--tint": x.tint } as React.CSSProperties}>
                <b>{x.name}</b>
                <span>{x.from}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="vt-mid">
          <Mascot tile wave tone="orange" size={64} className="vt-mascot" />
          <Safe turn={a} />
        </div>

        <div className="vt-col">
          <p className="sc-label">Pick an application</p>
          <div className="vt-apps" role="group" aria-label="Applications">
            {APPS.map((x, k) => (
              <button key={x.name} className="vt-app" aria-pressed={k === a} onClick={() => setA(k)}>
                <b>{x.name}</b>
                <span>{x.office}</span>
              </button>
            ))}
          </div>
          <div className="vt-out" key={a} aria-live="polite">
            <p className="rv" style={d(0.05)}><mark style={d(0.2)}>Filled from your vault.</mark></p>
            <p className="rv vt-out-small" style={d(0.3)}>{app.uses.length} things used, nothing typed twice. Waiting for your yes.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
