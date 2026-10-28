"use client";
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

function ProgramScene() {
  const rules: [string, string][] = [
    ["Budget", "$50,000"],
    ["Award", "Up to $500, once"],
    ["Who qualifies", "Families with a child under 5 in Sample County"],
    ["Proof", "One document showing the address"],
  ];
  return (
    <div className="sc sc-apply">
      <div className="sc-card t-rules-card">
        <div className="sc-card-head"><span>Winter family grant</span><span className="sc-label">Your rules</span></div>
        <dl>
          {rules.map(([k, v], n) => (
            <div key={k}><dt>{k}</dt><dd><span className="type" style={{ ...d(0.3 + n * 0.7), "--n": v.length } as React.CSSProperties}>{v}</span></dd></div>
          ))}
        </dl>
        <p className="sc-foot rv" style={d(3.2)}>Mano drafts the application.</p>
      </div>
      <div className="sc-thread">
        <p className="sc-label">Text message to a family who qualifies</p>
        <ManoSays style={d(3.8)}>Northside Family Center opened a winter grant: up to $500 for families with a child under 5. You look like a fit. Want me to apply?</ManoSays>
        <p className="bub me rv" style={d(4.9)}>Yes please</p>
        <ManoSays style={d(5.6)}>Done. I attached your lease. Northside will decide within 5 days.</ManoSays>
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
        { key: "org-program", tab: "Run your own grant program", Scene: ProgramScene },
        { key: "org-trail", tab: "Know where every case stands", Scene: TrailScene },
      ]}
    />
  );
}
