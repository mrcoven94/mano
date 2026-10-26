"use client";
import Mascot from "./Mascot";
import { Browser } from "./Devices";
import DemoTabs, { at, typed, type Demo } from "./DemoTabs";

/* What a staff member sees: four live demos. Every case, person and policy number is made up. */

const findings: [title: string, detail: string, cite: string, start: number][] = [
  ["Income is under the limit", "$2,140 a month. Limit is $2,610 for 3 people. Two March pay stubs attached.", "Policy 4.2(b)", 900],
  ["Lives in the county", "Lease, page 1, matches the address on file.", "Policy 2.1", 2300],
  ["Household size confirmed", "3 people, same as the last approved renewal.", "Policy 3.4", 3700],
  ["Signed on time", "Signed Oct 28. Due Nov 18.", "Policy 6.1", 5100],
];

function CaseDemo({ t }: { t: number }) {
  const done = at(t, 6200);
  return (
    <Browser url="mano · case review" className="wm-browser">
      <div className="gv-case">
        <div className="gv-head">
          <span><small>Benefits renewal · Case 0418</small><strong>Maria Lopez, household of 3</strong></span>
          <span className={`gv-status${done ? " ok" : ""}`}>{done ? "Complete" : "Checking"}</span>
        </div>
        <ul className="gv-findings">
          {findings.map(([title, detail, cite, s]) => (
            <li key={title} className={at(t, s) ? "in" : ""}>
              <span className="gv-tick" />
              <span><strong>{title}</strong><small>{detail}</small></span>
              <span className="gv-cite">{cite}</span>
            </li>
          ))}
        </ul>
        <div className="gv-docs">{["Renewal form, 4 pages", "Pay stub, Mar 1", "Pay stub, Mar 15", "Lease"].map((d) => <span key={d}>{d}</span>)}</div>
        <div className={`gv-actions${done ? " in" : ""}`}><span className="btn btn-primary btn-sm">Approve</span><span className="btn btn-ghost btn-sm">Ask for more</span><small>Staff approve before anything is sent.</small></div>
      </div>
    </Browser>
  );
}

const policy = [
  "Section 3. Eligible households have at least one child under 13 and monthly income at or below 200 percent of the federal poverty level.",
  "Section 4. Applicants provide proof of income for the last 30 days and proof of address.",
  "Section 7. Awards are up to $500 a month, paid to a licensed provider.",
];
const questions: [string, number][] = [["How many children under 13 live with you?", 2600], ["What did your household earn in the last 30 days?", 3600], ["What is your home address?", 4600]];
const evidence: [string, number][] = [["Pay stubs or income letter, last 30 days", 5600], ["Lease, utility bill or ID with address", 6300], ["Provider license number", 7000]];

function PolicyDemo({ t }: { t: number }) {
  return (
    <Browser url="mano · new program" className="wm-browser">
      <div className="gv-policy">
        <div className="gv-doc">
          <small>Child care subsidy policy, draft 3</small>
          {policy.map((p, k) => <p key={k} className={at(t, 600 + k * 900) ? "hl" : ""}>{p}</p>)}
        </div>
        <div className="gv-out">
          <p className="gv-out-head"><Mascot size={20} tile tone="orange" /> Drafted from the policy</p>
          <small>Questions residents answer</small>
          <ul>{questions.map(([q, s]) => <li key={q} className={at(t, s) ? "in" : ""}>{q}</li>)}</ul>
          <small>Evidence to collect</small>
          <ul>{evidence.map(([q, s]) => <li key={q} className={at(t, s) ? "in" : ""}>{q}</li>)}</ul>
          <p className={`gv-review${at(t, 7800) ? " in" : ""}`}>Draft ready for staff review. Nothing goes live until you approve it.</p>
        </div>
      </div>
    </Browser>
  );
}

const screen: [label: string, value: string, start: number][] = [
  ["CASE NO", "0418", 800],
  ["LAST NAME", "LOPEZ", 1500],
  ["HH SIZE", "3", 2300],
  ["GROSS INC", "2140.00", 2900],
  ["PROGRAM", "CCS", 3700],
  ["ACTION", "RENEW", 4400],
];
const steps: [string, number][] = [["Opened case 0418", 600], ["Entered household and income", 3200], ["Attached 4 documents", 5200], ["Saved. Notice queued for staff", 6400]];

function SystemDemo({ t }: { t: number }) {
  return (
    <div className="gv-system">
      <div className="gv-term" aria-label="An older case system being filled in by the agent" role="img">
        <p className="gv-term-head">CASE MAINTENANCE · SCREEN 14</p>
        {screen.map(([label, value, s]) => {
          const v = typed(t, s, value, 14);
          return <p key={label}><span>{label.padEnd(10, ".")}</span><b>{v}{v.length > 0 && v.length < value.length ? "▌" : ""}</b></p>;
        })}
        <p className="gv-term-foot">F3 EXIT · F5 SAVE · F7 ATTACH</p>
      </div>
      <div className="gv-steps">
        <p className="gv-out-head"><Mascot size={20} tile tone="orange" /> Typing into your system</p>
        <ul>{steps.map(([s, at0]) => <li key={s} className={at(t, at0) ? "done" : ""}>{s}</li>)}</ul>
        <span className="btn btn-ghost btn-sm">Stop the agent</span>
        <small>Staff can watch every keystroke and stop it at any point.</small>
      </div>
    </div>
  );
}

function NoticeDemo({ t }: { t: number }) {
  const plain = at(t, 2600);
  return (
    <Browser url="mano · notices" className="wm-browser">
      <div className="gv-notice">
        <div className="gv-langs"><span className={!plain ? "on" : ""}>Template</span><span className={plain ? "on" : ""}>Plain language · Español</span></div>
        {!plain ? (
          <p className="gv-legal">Pursuant to Section 6.1 of the program rules, the recertification submitted on the date indicated has been reviewed and your continued eligibility has been determined to be in effect for the certification period stated herein, subject to the reporting requirements set forth in Section 8.</p>
        ) : (
          <div className="gv-plain">
            <p><b>Su renovación fue aprobada.</b></p>
            <p>{typed(t, 2800, "Su ayuda para el cuidado de niños sigue igual hasta el 30 de noviembre de 2027. Si su ingreso cambia, avísenos en 10 días. Mano puede hacerlo por usted.", 60)}</p>
          </div>
        )}
        <div className={`gv-actions${at(t, 6000) ? " in" : ""}`}><span className="btn btn-primary btn-sm">Approve this text</span><small>Staff approve before anything is sent.</small></div>
      </div>
    </Browser>
  );
}

const demos: Demo[] = [
  { id: "gov-case", title: "Review a complete case", text: "Every finding is cited to the rule it rests on, with the evidence attached.", Demo: CaseDemo },
  { id: "gov-policy", title: "Turn a policy into a program", text: "Give Mano the policy. It drafts the questions, the evidence list and the notices.", Demo: PolicyDemo },
  { id: "gov-system", title: "Type it into your system", text: "After staff approve, the agent enters the case into the system you already run.", Demo: SystemDemo },
  { id: "gov-notice", title: "Approve a plain notice", text: "Decisions go out in plain language, in the language the resident asked for.", Demo: NoticeDemo },
];

export default function GovDemos() {
  return <DemoTabs demos={demos} label="What your agent does" duration={9000} />;
}
