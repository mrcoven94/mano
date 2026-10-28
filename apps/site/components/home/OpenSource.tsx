"use client";
import { useState } from "react";
import Mascot from "@/components/Mascot";
import { REPO_URL } from "@/lib/site";

/* Open source, shown rather than told: the consent record, the action log and the three commands to run it.
   Taking consent back rewrites the record live. Every value is made up. */

type Tok = [cls: "k" | "s" | "n" | "p", text: string];
type Line = { t: Tok[]; hot?: boolean };

const k = (x: string): Tok => ["k", `"${x}"`];
const s = (x: string): Tok => ["s", `"${x}"`];
const p = (x: string): Tok => ["p", x];
const n = (x: string): Tok => ["n", x];

function consent(revoked: boolean): Line[] {
  return [
    { t: [p("{")] },
    { t: [p("  "), k("type"), p(": "), s("consent.grant"), p(",")] },
    { t: [p("  "), k("from"), p(": "), s("person:maria-lopez"), p(",")] },
    { t: [p("  "), k("to"), p(": "), s("org:northside-family-center"), p(",")] },
    { t: [p("  "), k("purpose"), p(": "), s("food-benefits-renewal"), p(",")] },
    { t: [p("  "), k("documents"), p(": ["), s("pay-stub-2026-10-24"), p("],")] },
    { t: [p("  "), k("expires"), p(": "), s("2026-12-31"), p(",")] },
    revoked
      ? { t: [p("  "), k("revoked_at"), p(": "), s("2026-11-02T09:14:00Z")], hot: true }
      : { t: [p("  "), k("revocable"), p(": "), n("true")] },
    { t: [p("}")] },
  ];
}

const LOG: Line[] = [
  { t: [n("09:55"), p("  "), s("decide"), p("   approve renewal, case 0418")] },
  { t: [n("09:55"), p("  "), s("log"), p("      recipient, purpose, copy 7f3a")] },
  { t: [n("09:56"), p("  "), s("act"), p("      submit to Sample County")] },
  { t: [n("09:56"), p("  "), s("check"), p("    received once, matches")], hot: true },
];

const RUN: Line[] = [
  { t: [n("$"), p(` git clone ${REPO_URL}`)] },
  { t: [n("$"), p(" cd mano && pnpm install")] },
  { t: [n("$"), p(" pnpm check")] },
  { t: [s("Every package checked. Stand-ins used for 3 services.")], hot: true },
];

const TABS = [["consent", "Consent"], ["log", "Action log"], ["run", "Run it"]] as const;
type Tab = (typeof TABS)[number][0];

export default function OpenSource() {
  const [tab, setTab] = useState<Tab>("consent");
  const [revoked, setRevoked] = useState(false);
  const lines = tab === "consent" ? consent(revoked) : tab === "log" ? LOG : RUN;

  return (
    <div className="wrap open-grid">
      <div>
        <h2 id="open-h">Open source, from the first commit.</h2>
        <p className="lede">The code and the protocol that lets agents share a case are public. Any agency, nonprofit or developer can read how Mano works, build on it or run their own copy.</p>
        <ul className="open-facts">
          <li><b>Consent is a record.</b> Every share names who, why and until when, and can be taken back.</li>
          <li><b>Every action is logged first.</b> Mano decides, writes it down, then acts. If anything is unclear, it stops.</li>
          <li><b>Runs without our accounts.</b> Every part works locally with stand-ins, so you can try it today.</li>
        </ul>
        <div className="btn-row" style={{ marginTop: 32 }}>
          <a className="btn btn-primary" href={REPO_URL}>Read the code</a>
          <a className="btn btn-ghost" href={`${REPO_URL}#readme`}>Run your own</a>
        </div>
      </div>

      <div className="os">
        <Mascot tile wave tone="orange" size={64} className="os-mascot" />
        <div className="os-win">
          <div className="os-tabs" role="tablist" aria-label="Examples">
            {TABS.map(([key, label]) => (
              <button key={key} role="tab" aria-selected={tab === key} className="os-tab" onClick={() => setTab(key)}>{label}</button>
            ))}
          </div>
          <pre className="os-code" key={`${tab}-${revoked}`}>
            {lines.map((l, i) => (
              <span key={i} className={`os-line${l.hot ? " hot" : ""}`} style={{ "--d": `${i * 0.05}s` } as React.CSSProperties}>
                {l.t.map(([c, x], j) => <span key={j} className={`t-${c}`}>{x}</span>)}
              </span>
            ))}
          </pre>
          {tab === "consent" && (
            <div className="os-foot">
              <p>{revoked ? "Northside can no longer see the pay stub." : "Maria shared one pay stub with Northside, for one renewal."}</p>
              <button className="os-btn" onClick={() => setRevoked((r) => !r)}>{revoked ? "Share it again" : "Take it back"}</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
