"use client";
import SceneTabs from "./SceneTabs";
import { Check, ManoHead, d } from "./Parts";

/* Three more things an office's agent does. Each plays once when it mounts. Every case and rule is made up. */

function PolicyScene() {
  const policy: [string, string, string][] = [
    ["Section 3.", "Eligible households have at least one child under 13 and ", "monthly income at or below 200 percent of the federal poverty level."],
    ["Section 4.", "Applicants provide ", "proof of income for the last 30 days and proof of address."],
    ["Section 7.", "Awards are ", "up to $500 a month, paid to a licensed provider."],
  ];
  const asks: [string, string][] = [
    ["How many children under 13 live with you?", "Sec. 3"],
    ["What did your household earn in the last 30 days?", "Sec. 3"],
    ["Which licensed provider cares for your children?", "Sec. 7"],
  ];
  const proof: [string, string][] = [
    ["Pay stubs or an income letter, last 30 days", "Sec. 4"],
    ["A lease, utility bill or ID showing the address", "Sec. 4"],
  ];
  return (
    <div className="sc t-two">
      <div className="t-doc">
        <p className="sc-label">Child care subsidy policy, draft 3</p>
        {policy.map(([s, a, b], n) => <p key={s}><b>{s}</b> {a}<mark style={d(0.4 + n * 0.8)}>{b}</mark></p>)}
      </div>
      <div className="sc-card">
        <div className="sc-card-head"><ManoHead>Drafted from the policy</ManoHead><span className="sc-label">For staff review</span></div>
        <p className="t-sub">Questions residents answer</p>
        <ul className="sc-rows tight">
          {asks.map(([q, c], n) => <li key={q} className="rv t-cited" style={d(2.4 + n * 0.45)}><Check /><div><strong>{q}</strong></div><span className="t-cite">{c}</span></li>)}
        </ul>
        <p className="t-sub">Proof to collect</p>
        <ul className="sc-rows tight">
          {proof.map(([q, c], n) => <li key={q} className="rv t-cited" style={d(3.8 + n * 0.45)}><Check /><div><strong>{q}</strong></div><span className="t-cite">{c}</span></li>)}
        </ul>
        <p className="sc-foot rv" style={d(4.8)}>Nothing serves residents until your staff approve it.</p>
      </div>
    </div>
  );
}

function QueueScene() {
  const rows: [string, string, string, string, string][] = [
    ["M. Lopez", "Food benefits renewal", "Complete", "4 rules checked, each one cited", ""],
    ["A. Haddad", "Child care help", "Complete", "5 rules checked, each one cited", ""],
    ["K. Brooks", "Emergency rent help", "Waiting on resident", "Asked for page 2 of the lease on Oct 25", "wait"],
    ["P. Ruiz", "Food benefits", "Needs a person", "Two pay stubs name different employers. Mano did not guess.", "flag"],
    ["T. Nguyen", "Power bill credit", "Complete", "3 rules checked, each one cited", ""],
  ];
  return (
    <div className="sc">
      <div className="sc-card">
        <div className="sc-card-head"><span>Today&rsquo;s queue</span><span className="sc-label">Eligibility desk · 5 cases</span></div>
        <ul className="t-queue">
          {rows.map(([who, prog, status, note, kind], n) => (
            <li key={who} className="rv" style={d(0.3 + n * 0.4)}>
              <div><strong>{who}</strong><small>{prog}</small></div>
              <p>{note}</p>
              <span className={`t-status ${kind}`}>{status}</span>
            </li>
          ))}
        </ul>
        <p className="sc-foot rv" style={d(2.6)}>Mano flags what it cannot settle. A person decides every case.</p>
      </div>
    </div>
  );
}

function NoticeScene() {
  const plain = "Su ayuda para comida sigue igual hasta el 31 de octubre de 2027. Si su ingreso cambia, avísenos en 10 días. Mano puede hacerlo por usted.";
  return (
    <div className="sc t-two">
      <div className="t-doc dim">
        <p className="sc-label">Notice template 6.1</p>
        <p>Pursuant to Section 6.1 of the program rules, the recertification submitted on the date indicated has been reviewed and continued eligibility has been determined to be in effect for the certification period stated herein, subject to the reporting requirements set forth in Section 8.</p>
      </div>
      <div className="sc-card">
        <div className="sc-card-head"><ManoHead>Notice for Maria Lopez</ManoHead><span className="sc-label">Plain language · Español</span></div>
        <p className="t-notice-h rv" style={d(0.4)}>Su renovación fue aprobada.</p>
        <p className="t-notice rv" style={d(0.9)}>{plain}</p>
        <ul className="t-docs rv" style={d(1.8)}><li>Same facts as template 6.1</li><li>Reading level: grade 5</li><li>Language she asked for</li></ul>
        <p className="sc-foot rv" style={d(2.4)}>Waiting for staff to approve the exact text. Nothing is sent before that.</p>
      </div>
    </div>
  );
}

export default function GovScenes() {
  return (
    <SceneTabs
      label="More of what your agent does"
      scenes={[
        { key: "gov-policy", tab: "Launch a program from a policy", Scene: PolicyScene },
        { key: "gov-queue", tab: "Clear the queue", Scene: QueueScene },
        { key: "gov-notice", tab: "Send notices people understand", Scene: NoticeScene },
      ]}
    />
  );
}
