"use client";
import SceneTabs from "./SceneTabs";
import { Check, ManoHead, ManoSays, d } from "./Parts";

/* Three rules every extension lives under, played out. The services and people are made up. */

function FitScene() {
  const rows: [string, string, string][] = [
    ["How do I build my credit?", "Offered: Rent reporting", "Matches what the service says it does."],
    ["Renew my food benefits", "No service offered", "Mano does this itself, for free."],
    ["Find me a cheaper phone plan", "Nothing offered", "No reviewed service fits. Mano says so."],
  ];
  return (
    <div className="sc">
      <div className="sc-card">
        <div className="sc-card-head"><span>What people asked, and what Mano offered</span><span className="sc-label">No ads, no paid placement</span></div>
        <ul className="t-match">
          {rows.map(([q, a, s], n) => (
            <li key={q} className="rv" style={d(0.3 + n * 0.7)}>
              <span className="q">{q}</span>
              <span className="arr" aria-hidden="true">&rarr;</span>
              <span className="a"><strong>{a}</strong><small>{s}</small></span>
            </li>
          ))}
        </ul>
        <p className="sc-foot rv" style={d(2.6)}>A service shows up only for the request it fits. Paying more does not move it up.</p>
      </div>
    </div>
  );
}

function ReviewScene() {
  const checks: [string, string][] = [
    ["Asks for the least data it needs", "2 fields: rent amount and paid dates"],
    ["States the cost to the person", "Nothing. The service provider pays."],
    ["Stops in one step", "And deletes the data within 30 days"],
    ["Every link passes the safety check", "3 links checked"],
    ["Tools do only what it says", "1 tool: report_rent_payment"],
  ];
  return (
    <div className="sc">
      <div className="sc-card">
        <div className="sc-card-head"><ManoHead>Review: sample-rent-reporting</ManoHead><span className="sc-label">Before anyone sees it</span></div>
        <ul className="sc-rows">
          {checks.map(([t, s], n) => (
            <li key={t} className="rv" style={d(0.3 + n * 0.5)}>
              <Check />
              <div><strong>{t}</strong><small>{s}</small></div>
              <span className="t-status">Passed</span>
            </li>
          ))}
        </ul>
        <p className="sc-foot rv" style={d(3)}>Approved for people in Sample County. Any change to the manifest is reviewed again.</p>
      </div>
    </div>
  );
}

function RemoveScene() {
  return (
    <div className="sc sc-apply">
      <div className="sc-card">
        <div className="sc-card-head"><span>Services you turned on</span><span className="sc-label">Maria&rsquo;s Mano</span></div>
        <ul className="sc-rows">
          <li><Check /><div><strong>Rent reporting</strong><small>Since Oct 27. Uses rent amount and paid dates.</small></div><span className="t-status flag">Removed today</span></li>
          <li><Check /><div><strong>Job training match</strong><small>Since Sep 3. Uses the jobs you said you want.</small></div><span className="t-status">On</span></li>
        </ul>
      </div>
      <div className="sc-thread">
        <p className="sc-label">After Maria taps Remove</p>
        <ManoSays style={d(0.6)}>Rent reporting is off. They stopped getting your data today.</ManoSays>
        <div className="sc-card rv" style={d(1.5)}>
          <ol className="t-trail">
            <li className="ok"><div><strong>Data stopped</strong><small>No new rent records sent</small></div><span className="ts">Oct 30</span></li>
            <li className="ok"><div><strong>Deletion requested</strong><small>Due by Nov 29, as the manifest promised</small></div><span className="ts">Oct 30</span></li>
            <li><div><strong>Partner confirms deletion</strong><small>Mano tells Maria when it arrives</small></div><span className="ts">Pending</span></li>
          </ol>
        </div>
      </div>
    </div>
  );
}

export default function PartnerScenes() {
  return (
    <SceneTabs
      label="The rules every extension lives under"
      scenes={[
        { key: "pt-fit", tab: "Offered only when it fits", Scene: FitScene },
        { key: "pt-review", tab: "Reviewed before anyone sees it", Scene: ReviewScene },
        { key: "pt-remove", tab: "Removed in one tap", Scene: RemoveScene },
      ]}
    />
  );
}
