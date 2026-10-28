"use client";
import { useState } from "react";

/* The case arrives with its documents already there, each fact showing where it came from. Try a clean case,
   a mismatch and a duplicate to see what Mano flags for staff. Every person and number here is made up. */

const d = (s: number) => ({ "--d": `${s}s` }) as React.CSSProperties;

type Row = { label: string; value: string; from: string; flag?: string };

const BASE: Row[] = [
  { label: "Name", value: "Maria Lopez", from: "Photo ID" },
  { label: "Address", value: "1418 Sample St, Apt 3", from: "Lease" },
  { label: "Monthly income", value: "$2,570", from: "Confirmed with payroll" },
  { label: "Household", value: "3 people", from: "Official birth records" },
  { label: "Power bill", value: "$142 a month", from: "Photo of the bill" },
];

const CASES = [
  {
    key: "clean", name: "A clean case",
    rows: BASE,
    checks: [["Documents agree", true], ["No other open application", true], ["Income confirmed with payroll", true]] as [string, boolean][],
    note: "Ready for review. Every fact links to its page.",
  },
  {
    key: "mismatch", name: "A mismatch",
    rows: BASE.map((r) => (r.label === "Power bill" ? { ...r, value: "$142 a month, 22 Oak Ave", flag: "Address does not match the lease" } : r)),
    checks: [["Documents do not agree", false], ["No other open application", true], ["Income confirmed with payroll", true]] as [string, boolean][],
    note: "Flagged. Mano asked Maria for a bill at her current address before sending this to staff.",
  },
  {
    key: "duplicate", name: "A duplicate",
    rows: BASE,
    checks: [["Documents agree", true], ["Another open application for this person", false], ["Income confirmed with payroll", true]] as [string, boolean][],
    note: "Held. The same person has an open application from Oct 3, so Mano sent both to staff instead of filing again.",
  },
];

export default function Verified({ id, office }: { id: string; office: string }) {
  const [k, setK] = useState(0);
  const c = CASES[k];

  return (
    <section className="t-vf" aria-labelledby={`${id}-h`}>
      <div className="wrap vf-grid">
        <div>
          <h2 id={`${id}-h`}>Faster reviews, fewer mistakes, less fraud.</h2>
          <p className="lede">When a case reaches you, the documents are already there. Mano confirms income with banks and payroll, pulls official records and checks that every document agrees. It catches the same person applying twice, and every fact links to where it came from.</p>
          <ul className="open-facts">
            <li><b>Every fact shows its source,</b> so review takes minutes, not a stack of paper.</li>
            <li><b>Your forms, your system.</b> Mano fills your own forms field by field, or hands over a file your system can load. Staff never learn a new portal.</li>
            <li><b>Staff decide.</b> Mano flags what does not add up and never approves or denies.</li>
          </ul>
        </div>

        <div className="vf-stage">
          <div className="vf-tabs" role="group" aria-label="Try a case">
            {CASES.map((x, n) => (
              <button key={x.key} className="vf-tab" aria-pressed={n === k} onClick={() => setK(n)}>{x.name}</button>
            ))}
          </div>
          <div className="vf-case" key={c.key} aria-live="polite">
            <div className="vf-head">
              <span><b>Food benefits renewal</b><small>{office} · Case 0418</small></span>
            </div>
            <dl>
              {c.rows.map((r, n) => (
                <div key={r.label} className="rv" data-flag={r.flag ? true : undefined} style={d(0.05 + n * 0.07)}>
                  <dt>{r.label}</dt>
                  <dd><b>{r.value}</b><span className="vf-src">{r.flag ?? r.from}</span></dd>
                </div>
              ))}
            </dl>
            <ul className="vf-checks">
              {c.checks.map(([t, ok], n) => (
                <li key={t} className="rv" data-ok={ok || undefined} style={d(0.5 + n * 0.1)}>{ok ? "Passed" : "Flagged"}<span>{t}</span></li>
              ))}
            </ul>
            <p className="vf-note rv" style={d(0.85)}>{c.note}</p>
          </div>
        </div>
      </div>
    </section>
  );
}
