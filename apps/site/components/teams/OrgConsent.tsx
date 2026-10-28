"use client";
import { useState } from "react";
import { Check, ManoHead, ManoSays, d } from "./Parts";

/* A case manager asks for one missing page. The family's own Mano asks them, and only a yes moves it.
   Everyone and every organization here is made up. */

type Step = "idle" | "asked" | "shared" | "declined" | "revoked";

export default function OrgConsent() {
  const [s, setS] = useState<Step>("idle");
  const go = (x: Step) => setS(x);
  const got = s === "shared" || s === "revoked";

  const stub =
    s === "idle" ? ["Missing", "Needed for income, rule 4.2(b)"] :
    s === "asked" ? ["Asked Maria", "Requested 10:02 AM. You see nothing until she says yes."] :
    s === "declined" ? ["Maria said not now", "Nothing was shared. Call her, or ask again later."] :
    ["Received 10:04 AM", "One page, for this renewal only"];

  return (
    <div className="oc">
      <div>
      <p className="t-who">Dana&rsquo;s desk at Northside</p>
      <div className="sc-card">
        <div className="gd-head">
          <div><p className="sc-label">Northside case 0418 · Food benefits renewal</p><strong>Maria Lopez, household of 3</strong></div>
          <span className="sc-tag">Due Nov 14</span>
        </div>
        <ul className="oc-list">
          <li><Check /><div><strong>Renewal form</strong><small>Drafted from the case file, 4 pages</small></div></li>
          <li><Check /><div><strong>Pay stub, Oct 10</strong><small>Shared by Maria on Oct 12</small></div></li>
          <li>
            {got ? <Check /> : <span className="oc-missing" aria-hidden="true" />}
            <div><strong>Pay stub, Oct 24</strong><small>{stub[1]}</small></div>
            <span className={`t-status ${got ? "" : s === "declined" ? "flag" : s === "asked" ? "pen" : "wait"}`}>{stub[0]}</span>
          </li>
        </ul>
        <div className="oc-act" aria-live="polite">
          {s === "idle" && (
            <>
              <div className="gd-btns"><button className="btn btn-pen btn-sm t-pulse" onClick={() => go("asked")}>Ask Maria for it</button></div>
              <p>Your agent asks Maria&rsquo;s own Mano. It never reaches into her files.</p>
            </>
          )}
          {s === "asked" && <p className="rv" style={d(0)}>Waiting for Maria. Her Mano explains who is asking, for what, and until when.</p>}
          {s === "declined" && (
            <div className="gd-done"><p>No access. Nothing changes on your side.</p><button className="btn btn-ghost btn-sm" onClick={() => go("idle")}>Start over</button></div>
          )}
          {got && (
            <>
              <div className="oc-rec-h"><span className="sc-label">Consent record</span><button className="btn btn-ghost btn-sm" onClick={() => go("idle")}>Start over</button></div>
              <dl className="oc-rec">
                <div className="rv" style={d(0.1)}><dt>Shared</dt><dd>Pay stub, Oct 24. 1 page.</dd></div>
                <div className="rv" style={d(0.25)}><dt>With</dt><dd>Northside Family Center</dd></div>
                <div className="rv" style={d(0.4)}><dt>For</dt><dd>Food benefits renewal only</dd></div>
                <div className="rv" style={d(0.55)}><dt>Until</dt><dd>Dec 31, 2026</dd></div>
                <div className="rv" style={d(0.7)}><dt>Status</dt><dd className={s === "revoked" ? "off" : ""}>{s === "revoked" ? "Stopped by Maria on Oct 27. You keep the page already sent." : "Active. Maria can stop it any time."}</dd></div>
              </dl>
            </>
          )}
        </div>
      </div>

      </div>

      <div>
      <p className="t-who">Maria&rsquo;s phone</p>
      <div className="t-phone" aria-label="Maria's phone" role="group">
        <p className="t-phone-head"><ManoHead>Mano</ManoHead></p>
        <div className="t-thread" aria-live="polite">
          {s === "idle" ? (
            <ManoSays>Your renewal is almost ready. I&rsquo;ll let you know if anyone asks for anything.</ManoSays>
          ) : (
            <>
              <ManoSays style={d(0.4)}>Dana at Northside Family Center is asking for your <b>October 24 pay stub</b>, for your food benefits renewal. Share only that page with Northside until December 31?</ManoSays>
              {s === "asked" && (
                <div className="t-choice rv" style={d(1)}>
                  <button className="btn btn-pen t-pulse" onClick={() => go("shared")}>Share it</button>
                  <button className="btn btn-ghost" onClick={() => go("declined")}>Not now</button>
                </div>
              )}
              {s === "declined" && <p className="bub me">Not now</p>}
              {s === "declined" && <ManoSays style={d(0.4)}>Okay. I told Dana you said not now. Nothing was shared.</ManoSays>}
              {got && <p className="bub me">Share it</p>}
              {got && <ManoSays style={d(0.4)}>Shared. Dana can see that one page, for your renewal only.</ManoSays>}
              {s === "shared" && (
                <div className="t-choice rv" style={d(1)}><button className="btn btn-ghost" onClick={() => go("revoked")}>Stop sharing with Northside</button></div>
              )}
              {s === "revoked" && <p className="bub me">Stop sharing with Northside</p>}
              {s === "revoked" && <ManoSays style={d(0.4)}>Done. Northside can&rsquo;t see anything new. They already have the October 24 pay stub, and I can&rsquo;t pull that copy back.</ManoSays>}
            </>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}
