"use client";
import { useState } from "react";
import SceneTabs from "./SceneTabs";
import { ManoHead, ManoSays, d } from "./Parts";

/* Three more things a case manager's agent does. Each plays once when it mounts. Every person is made up. */

function MorningScene() {
  const rows: [string, string, string, string, string][] = [
    ["Maria Lopez", "Food benefits renewal", "Drafted from the case file. Due Nov 14.", "Draft ready", "pen"],
    ["Sam Nguyen", "Job training grant", "All 3 documents matched to the rules.", "Draft ready", "pen"],
    ["Jo Chen", "Rent help", "Asked Jo for page 2 of the lease on Oct 25.", "Waiting on Jo", "wait"],
    ["Ana Reyes", "Child care help", "Two income amounts disagree. Mano did not pick one.", "Needs you", "flag"],
    ["Tomas Okafor", "Cash assistance", "Approved Oct 24. Notice sent in English.", "Done", ""],
  ];
  return (
    <div className="sc">
      <div className="sc-card">
        <div className="sc-card-head"><ManoHead>Dana&rsquo;s caseload</ManoHead><span className="sc-label">Monday, 8:00 AM</span></div>
        <ul className="t-queue">
          {rows.map(([who, prog, note, status, kind], n) => (
            <li key={who} className="rv" style={d(0.3 + n * 0.4)}>
              <div><strong>{who}</strong><small>{prog}</small></div>
              <p>{note}</p>
              <span className={`t-status ${kind}`}>{status}</span>
            </li>
          ))}
        </ul>
        <p className="sc-foot rv" style={d(2.6)}>2 drafts ready, 1 question for you.</p>
      </div>
    </div>
  );
}

const PROGRAMS: { name: string; rules: [string, string][]; ask: string; done: string }[] = [
  {
    name: "Emergency rent",
    rules: [["Budget", "$120,000"], ["Award", "Up to $1,500, once a year"], ["Who qualifies", "Renters in Sample County with a late notice"], ["Proof", "The notice and the lease"]],
    ask: "Northside can cover up to $1,500 of rent when there is a late notice. You have one from Oct 3. Want me to apply?",
    done: "Done. I sent your notice and lease. Northside will decide within 3 days.",
  },
  {
    name: "Food",
    rules: [["Budget", "$40,000"], ["Award", "$100 grocery card, monthly"], ["Who qualifies", "Families waiting on food benefits"], ["Proof", "The food benefits application"]],
    ask: "Northside gives a $100 grocery card each month while food benefits are pending. Yours is pending. Want me to apply?",
    done: "Done. Your first card arrives this week.",
  },
  {
    name: "Cash aid",
    rules: [["Budget", "$60,000"], ["Award", "Up to $400, once"], ["Who qualifies", "Anyone in Sample County facing a sudden loss of income"], ["Proof", "One pay stub or a letter from work"]],
    ask: "Northside has emergency cash, up to $400, for a sudden loss of income. Your hours were cut. Want me to apply?",
    done: "Done. I attached your last pay stub. Northside will decide within 2 days.",
  },
  {
    name: "Child care",
    rules: [["Budget", "$50,000"], ["Award", "Up to $500 a month"], ["Who qualifies", "Working parents with a child under 5"], ["Proof", "A pay stub and the provider's name"]],
    ask: "Northside helps pay for child care, up to $500 a month, for working parents. Leo is 4. Want me to apply?",
    done: "Done. I added Little Oaks as your provider. Northside will decide within 5 days.",
  },
  {
    name: "Guaranteed income",
    rules: [["Budget", "$240,000"], ["Award", "$500 a month for 12 months"], ["Who qualifies", "Single parents earning under $30,000"], ["Proof", "Last year's income"]],
    ask: "Northside is choosing 40 single parents for $500 a month for a year. You qualify. Want me to enter you?",
    done: "Done. Northside picks families on Dec 1, and I will tell you either way.",
  },
];

function ProgramScene() {
  const [p, setP] = useState(0);
  const prog = PROGRAMS[p];
  return (
    <div className="sc sc-apply">
      <div className="sc-card t-rules-card">
        <div className="t-prog-picks" role="group" aria-label="Kind of program">
          {PROGRAMS.map((x, n) => <button key={x.name} className="vf-tab" aria-pressed={n === p} onClick={() => setP(n)}>{x.name}</button>)}
        </div>
        <dl key={p}>
          {prog.rules.map(([k, v], n) => (
            <div key={k}><dt>{k}</dt><dd><span className="type" style={{ ...d(0.2 + n * 0.5), "--n": v.length } as React.CSSProperties}>{v}</span></dd></div>
          ))}
        </dl>
        <p className="sc-foot">Your rules, your budget. Mano drafts the application.</p>
      </div>
      <div className="sc-thread" key={p}>
        <p className="sc-label">Text message to a family who qualifies</p>
        <ManoSays style={d(2.4)}>{prog.ask}</ManoSays>
        <p className="bub me rv" style={d(3.4)}>Yes please</p>
        <ManoSays style={d(4.1)}>{prog.done}</ManoSays>
      </div>
    </div>
  );
}

function ReportScene() {
  const nums: [string, string][] = [
    ["412", "families served"],
    ["$186,400", "given out"],
    ["3 days", "from asking to help"],
    ["87%", "still housed 90 days later"],
  ];
  const rows: [string, string, string][] = [
    ["Emergency rent", "118 families", "$141,000"],
    ["Food", "203 families", "$20,300"],
    ["Child care", "41 families", "$25,100"],
  ];
  return (
    <div className="sc">
      <div className="sc-card">
        <div className="sc-card-head"><span>Quarterly report for Sample Foundation</span><span className="sc-label">July to September</span></div>
        <ul className="t-report">
          {nums.map(([b, t], n) => <li key={t} className="rv" style={d(0.3 + n * 0.25)}><b>{b}</b><span>{t}</span></li>)}
        </ul>
        <ul className="t-report-rows">
          {rows.map(([a, b, c], n) => <li key={a} className="rv" style={d(1.4 + n * 0.25)}><strong>{a}</strong><span>{b}</span><span>{c}</span></li>)}
        </ul>
        <p className="sc-foot rv" style={d(2.4)}>Built from every case as it happens. Ready to send as a PDF or a spreadsheet.</p>
      </div>
    </div>
  );
}

function TrailScene() {
  const steps: [string, string, string, boolean][] = [
    ["Dana approved the draft", "Northside, Oct 27", "9:12 AM", true],
    ["Maria said yes", "Food benefits renewal", "9:40 AM", true],
    ["Submitted to Sample County", "Received as case 0418. Checked once, sent once.", "9:41 AM", true],
    ["County approved the renewal", "J. Park, eligibility worker", "Oct 29", true],
    ["Notice explained to Maria", "In Spanish, the language she asked for", "Oct 29", false],
  ];
  return (
    <div className="sc">
      <div className="sc-card">
        <div className="sc-card-head"><span>Maria Lopez · Food benefits renewal</span><span className="sc-label">From draft to decision</span></div>
        <ol className="t-trail">
          {steps.map(([t, s, ts, ok], n) => (
            <li key={t} className={`rv${ok ? " ok" : ""}`} style={d(0.3 + n * 0.55)}>
              <div><strong>{t}</strong><small>{s}</small></div>
              <span className="ts">{ts}</span>
            </li>
          ))}
        </ol>
        <p className="sc-foot rv" style={d(3.2)}>You see where every case stands without calling the county.</p>
      </div>
    </div>
  );
}

export default function OrgScenes() {
  return (
    <SceneTabs
      label="More of what your agent does"
      scenes={[
        { key: "org-morning", tab: "Start the day with drafts ready", Scene: MorningScene },
        { key: "org-program", tab: "Run your own programs", Scene: ProgramScene },
        { key: "org-report", tab: "Reports that write themselves", Scene: ReportScene },
        { key: "org-trail", tab: "Know where every case stands", Scene: TrailScene },
      ]}
    />
  );
}
