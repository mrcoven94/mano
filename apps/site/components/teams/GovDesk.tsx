"use client";
import { useState } from "react";
import { Check, ManoHead, d } from "./Parts";

/* A caseworker reviews a complete case and approves it by hand; the agent then types it into the office's older
   case system and reads the screen back. Everyone and every office here is made up. */

type Phase = "review" | "approved" | "asked";

const findings: [string, string, string][] = [
  ["Income is under the limit", "$2,140 a month. The limit for 3 people is $2,610.", "Rule 4.2(b)"],
  ["Lives in the county", "Lease, page 1, matches the address on file.", "Rule 2.1"],
  ["Household of 3", "Same as the last approved renewal.", "Rule 3.4"],
  ["Signed on time", "Signed Oct 24. Due Nov 14.", "Rule 6.1"],
];
const docs = ["Renewal form, 4 pages", "Pay stub, Oct 10", "Pay stub, Oct 24", "Lease"];

const fields: [string, string][] = [
  ["CASE NO", "0418"],
  ["LAST NAME", "LOPEZ"],
  ["FIRST NAME", "MARIA"],
  ["HH SIZE", "3"],
  ["GROSS INC", "2140.00"],
  ["PROGRAM", "FS"],
  ["ACTION", "RECERT"],
  ["CERT THRU", "10/31/2027"],
];

const approvedLog: [string, string, string?][] = [
  ["10:42:03", "Approved by J. Park. Covers copy 7f3a c19e."],
  ["10:42:05", "Opened case 0418 on screen 14"],
  ["10:42:11", "Entered household, income and dates"],
  ["10:42:14", "Attached 4 documents"],
  ["10:42:16", "Saved. Read the screen back: it matches the approved copy.", "ok"],
  ["10:42:17", "Approval notice drafted for J. Park to review"],
];
const askedLog: [string, string, string?][] = [
  ["10:42:03", "J. Park asked for a current proof of address"],
  ["10:42:04", "Asked Maria's Mano. It tells her what is needed and why."],
  ["10:42:04", "Nothing entered. Case 0418 stays pending until it arrives.", "ok"],
];

export default function GovDesk() {
  const [phase, setPhase] = useState<Phase>("review");
  const go = (p: Phase) => setPhase(p);
  const step = 0.55;
  const log = phase === "approved" ? approvedLog : askedLog;
  const logAt = phase === "approved" ? [0, 0.6, 1.2 + fields.length * step * 0.6, 1.4 + fields.length * step, 1.9 + fields.length * step, 2.4 + fields.length * step] : [0, 0.6, 1.2];

  return (
    <div className="gd">
      <div>
      <p className="t-who">The caseworker&rsquo;s screen</p>
      <div className="sc-card gd-case">
        <div className="gd-head">
          <div><p className="sc-label">Food benefits renewal · Case 0418</p><strong>Maria Lopez, household of 3</strong></div>
          <span className="sc-tag">{phase === "review" ? "Complete" : phase === "approved" ? "Approved" : "Asked for more"}</span>
        </div>
        <ul className="sc-rows">
          {findings.map(([t, s, cite]) => (
            <li key={t}>
              <Check />
              <div><strong>{t}</strong><small>{s}</small></div>
              <span className="t-cite">{cite}</span>
            </li>
          ))}
        </ul>
        <ul className="t-docs" aria-label="Evidence attached">{docs.map((x) => <li key={x}>{x}</li>)}</ul>
        <div className="gd-act" aria-live="polite">
          {phase === "review" ? (
            <>
              <div className="gd-btns">
                <button className="btn btn-pen btn-sm t-pulse" onClick={() => go("approved")}>Approve</button>
                <button className="btn btn-ghost btn-sm" onClick={() => go("asked")}>Ask for more</button>
              </div>
              <p className="gd-note">Your approval covers this exact copy, <span className="tr-hash">7f3a c19e</span>. If anything changes, Mano asks again.</p>
            </>
          ) : (
            <div className="gd-done">
              <p>{phase === "approved" ? "Approved by J. Park, eligibility worker." : "Sent back to Maria for one more page."}</p>
              <button className="btn btn-ghost btn-sm" onClick={() => go("review")}>Start over</button>
            </div>
          )}
        </div>
      </div>
      </div>

      <div className="gd-right">
        <p className="t-who">The office&rsquo;s own case system</p>
        <div className="gd-sys" role="img" aria-label={phase === "approved" ? "The office's older case system, filled in by the agent and saved" : "The office's older case system, waiting"}>
          <p className="gd-sys-head"><span>CASE MAINTENANCE · SCREEN 14</span><span>SAMPLE COUNTY</span></p>
          <div className="gd-sys-body" key={phase}>
            {fields.map(([label, value], n) => (
              <p key={label}>
                <span>{label.padEnd(11, ".")}</span>
                <b>{phase === "approved" && <span className="type" style={{ ...d(1 + n * step), "--n": value.length } as React.CSSProperties}>{value}</span>}</b>
              </p>
            ))}
            {phase === "review" && <p className="gd-wait">Waiting for a caseworker&rsquo;s approval. Nothing is entered before that.</p>}
            {phase === "asked" && <p className="gd-wait rv" style={d(1.2)}>Nothing entered. Case 0418 stays pending.</p>}
            {phase === "approved" && <p className="gd-saved rv" style={d(1.9 + fields.length * step)}>RECORD SAVED  0418  10:42:16</p>}
          </div>
          <p className="gd-sys-foot">F3 EXIT   F5 SAVE   F7 ATTACH</p>
        </div>
        <div className="sc-card gd-log">
          <div className="sc-card-head"><ManoHead>What the agent did</ManoHead><span className="sc-label">Staff can stop it at any keystroke</span></div>
          {phase === "review" ? (
            <p className="gd-empty">The agent waits. It does not touch your system until a person approves the case.</p>
          ) : (
            <ol key={phase}>
              {log.map(([ts, text, kind], n) => (
                <li key={text} className={`rv ${kind ?? ""}`} style={d(logAt[n])}><span className="ts">{ts}</span><span>{text}</span></li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
