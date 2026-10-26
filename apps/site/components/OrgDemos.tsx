"use client";
import Mascot from "./Mascot";
import { Browser, IPhone } from "./Devices";
import DemoTabs, { at, typed, type Demo } from "./DemoTabs";

/* What a case manager sees: three live demos. Every person, place and amount is made up. */

const rows: [name: string, program: string, steps: [string, string, number][]][] = [
  ["R. Alvarez", "Benefits renewal", [["Due Nov 18", "", 0], ["Drafting from the case file", "now", 900], ["Draft ready for you", "ready", 3200]]],
  ["J. Chen", "Rent assistance", [["Needs a pay stub", "", 0], ["Asked their Mano", "now", 1800], ["Pay stub received", "done", 5200]]],
  ["S. Nguyen", "Job training grant", [["2 of 3 documents", "", 0], ["Matched lease to residency rule", "done", 4200]]],
  ["T. Okafor", "Cash assistance", [["Approved", "done", 0], ["Notice sent in English", "done", 2600]]],
];

function CaseloadDemo({ t }: { t: number }) {
  return (
    <Browser url="mano · your caseload" className="wm-browser">
      <div className="og-load">
        <div className="gv-head"><span><small>This week</small><strong>4 cases, 1 waiting on you</strong></span><span className={`gv-status${at(t, 3200) ? " ok" : ""}`}>{at(t, 3200) ? "1 draft to review" : "Agent working"}</span></div>
        <ul className="og-rows">
          {rows.map(([name, program, steps]) => {
            const [label, kind] = [...steps].reverse().find(([, , s]) => at(t, s)) ?? steps[0];
            return (
              <li key={name}>
                <span><strong>{name}</strong><small>{program}</small></span>
                <span className={`og-step ${kind}`}>{label}</span>
              </li>
            );
          })}
        </ul>
        <div className={`og-ready${at(t, 3600) ? " in" : ""}`}>
          <span><Mascot size={22} tile tone="orange" /><span><b>R. Alvarez renewal is ready</b><small>4 pages, drafted from the case file. Send to the county?</small></span></span>
          <span className="btn btn-primary btn-sm">Review draft</span>
        </div>
      </div>
    </Browser>
  );
}

function ChaseDemo({ t }: { t: number }) {
  const shared = at(t, 5200);
  return (
    <div className="og-chase">
      <div className="og-req card">
        <small>Your agent</small>
        <p>J. Chen&rsquo;s rent application needs a pay stub from the last 30 days.</p>
        <p className={`og-arrow${at(t, 1200) ? " in" : ""}`}>Asked J. Chen&rsquo;s Mano</p>
        <p className={`og-got${at(t, 6200) ? " in" : ""}`}>Received and matched to the income rule</p>
      </div>
      <IPhone className="og-phone">
        <div className="im-head small"><span /><span className="im-who"><Mascot size={30} tile tone="orange" /><small>Mano ›</small></span><span /></div>
        <ol className="og-thread">
          {at(t, 1800) && <li className="ev-msg mano"><p>Your case manager at Sample Family Center needs your latest pay stub for your rent application. I found it in your papers. Share only that page with them?</p></li>}
          {at(t, 4200) && <li className="ev-msg you"><p>{typed(t, 4200, "Yes, share it", 18)}</p></li>}
          {shared && <li className="ev-msg mano"><p>Shared. They can see that one page, for this application only.</p></li>}
        </ol>
      </IPhone>
    </div>
  );
}

const rules: [string, string, number][] = [
  ["Budget", "$50,000", 500],
  ["Award", "Up to $500, once", 1200],
  ["Who qualifies", "Families with a child under 5 in Sample County", 1900],
  ["Proof", "One document showing address", 2900],
];

function ProgramDemo({ t }: { t: number }) {
  return (
    <div className="og-chase">
      <div className="og-rules card">
        <small>Your rules</small>
        {rules.map(([k, v, s]) => <p key={k}><span>{k}</span><b>{typed(t, s, v, 30)}</b></p>)}
        <p className={`gv-review${at(t, 4400) ? " in" : ""}`}>Application drafted. Your team approves it before it opens.</p>
      </div>
      <IPhone className="og-phone">
        <div className="im-head small"><span /><span className="im-who"><Mascot size={30} tile tone="orange" /><small>Mano ›</small></span><span /></div>
        <ol className="og-thread">
          {at(t, 5200) && <li className="ev-msg mano"><p>Sample Family Center has a new grant: up to $500 for families with a child under 5. You qualify. Want me to apply?</p></li>}
          {at(t, 6800) && <li className="ev-msg you"><p>Yes</p></li>}
          {at(t, 7600) && <li className="ev-msg mano"><p>Done. I used the lease you already shared. You&rsquo;ll hear back within 5 days.</p></li>}
        </ol>
      </IPhone>
    </div>
  );
}

const demos: Demo[] = [
  { id: "org-caseload", title: "Review drafts from the case file", text: "Renewals and applications drafted from what your team already knows, ready for review.", Demo: CaseloadDemo },
  { id: "org-chase", title: "Get missing documents", text: "Your agent asks the resident's Mano. The resident shares one page, for one purpose.", Demo: ChaseDemo },
  { id: "org-program", title: "Launch a cash program", text: "Give Mano your rules and budget. Families who qualify hear about it and apply by text.", Demo: ProgramDemo },
];

export default function OrgDemos() {
  return <DemoTabs demos={demos} label="What your agent does" duration={9000} />;
}
