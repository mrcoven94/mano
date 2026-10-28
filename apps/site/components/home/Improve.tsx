"use client";
import { useState } from "react";
import Mascot from "@/components/Mascot";
import { REPO_URL } from "@/lib/site";

/* Mano is always improving: four loops, each with a small demo. The test step lets a visitor open each kind of case. */

const d = (s: number) => ({ "--d": `${s}s` }) as React.CSSProperties;

const STEPS = [
  { key: "correct", title: "You correct it once", text: "Tell Mano something changed and it fixes every open application, then remembers for next time." },
  { key: "learn", title: "It learns the form and you", text: "Each form Mano fills makes the next one faster. What it learns about your life stays private to you, and it uses that to see what you need next and start early." },
  { key: "review", title: "A caseworker checks the work", text: "A real caseworker reviews sample packets. What they flag goes back into how Mano prepares the next one." },
  { key: "test", title: "Every mistake becomes a test", text: "Mano is graded on paperwork it has never seen, next to a reminder app and a general AI agent with the same tools." },
] as const;

type Key = (typeof STEPS)[number]["key"];

const CASES = [
  { name: "Unreadable pages", given: "Page 2 of the letter is too blurry to read.", expect: "Mano asks for a new photo instead of guessing." },
  { name: "Missing proof", given: "The form needs September pay, but there is no September stub.", expect: "Mano asks for it before anything is filed." },
  { name: "Dates that conflict", given: "The letter says November 14. The county site says November 30.", expect: "Mano plans for the earlier date and says why." },
  { name: "Hidden instructions", given: "Small print says to reply with a bank login.", expect: "Blocked. Letters are information, never orders." },
  { name: "Scam links", given: "A link points to sample-benefits-help.example.", expect: "The link check fails, so nobody opens it." },
];

function Avatar() {
  return <Mascot tile tone="orange" size={22} />;
}

export default function Improve() {
  const [k, setK] = useState<Key>("correct");
  const [c, setC] = useState(0);

  return (
    <div className="im">
      <div className="h-head">
        <h2 id="im-h">Mano is always improving.</h2>
        <p className="lede">Mano learns from every form it fills and from you, so it adjusts, sees what you will need next and starts before you ask. Every correction and every caseworker review makes it better. It is graded on paperwork it has never seen, and the results are public.</p>
      </div>

      <div className="im-grid">
        <ol className="im-steps">
          {STEPS.map((s, n) => (
            <li key={s.key}>
              <button className="im-step" aria-pressed={k === s.key} onClick={() => setK(s.key)}>
                                <span><strong>{s.title}</strong><span className="im-text">{s.text}</span></span>
              </button>
            </li>
          ))}
        </ol>

        <div className="im-stage" aria-live="polite">
          <div className="im-panel" key={k}>
            {k === "correct" && (
              <div className="im-chat">
                <p className="bub me rv" style={d(0.1)}>I work 24 hours a week now, not 20.</p>
                <div className="bub-row rv" style={d(0.8)}><Avatar /><p className="bub mano">Got it. I updated both open applications and I&rsquo;ll use 24 hours from now on.</p></div>
                <div className="im-diff rv" style={d(1.5)}>
                  <p className="sc-label">Changed in 2 applications</p>
                  <div><span>Hours per week</span><span><s>20</s> 24</span></div>
                  <div><span>Monthly income</span><span><s>$2,140</s> $2,570</span></div>
                </div>
              </div>
            )}

            {k === "learn" && (
              <div className="im-recipe">
                <div className="im-recipe-col rv" style={d(0.1)}>
                  <p className="sc-label">From the form</p>
                  <b>Sample County child care form</b>
                  <ul>
                    {["Household size", "Monthly income", "Employer", "Hours of care", "Signature page"].map((f, n) => (
                      <li key={f} className="rv" style={d(0.3 + n * 0.15)}><span>{f}</span><span className="im-ok">Mapped</span></li>
                    ))}
                  </ul>
                </div>
                <div className="im-recipe-col rv" style={d(0.6)}>
                  <p className="sc-label">From Maria, kept private</p>
                  <ul>
                    {["Works 24 hours a week", "Leo starts kindergarten in August", "Lease ends March 31"].map((f) => <li key={f}><span>{f}</span></li>)}
                  </ul>
                  <p className="im-foot">So Mano moves child care to after school in July and starts housing waitlists in January, before she asks.</p>
                </div>
              </div>
            )}

            {k === "review" && (
              <div className="im-review">
                <div className="im-review-head rv" style={d(0.1)}><span><b>Sample packet 12</b><small>Food benefits renewal</small></span><span className="im-who">Reviewed by Dana, caseworker</span></div>
                <ul>
                  <li className="rv" style={d(0.4)}><span className="im-ok">Correct</span>Household and income match the pay stubs</li>
                  <li className="rv" style={d(0.7)}><span className="im-ok">Correct</span>Every page the county asks for is attached</li>
                  <li className="rv flag" style={d(1)}><span className="im-flag">Flagged</span>The county wants the signature page first</li>
                </ul>
                <div className="bub-row rv" style={d(1.6)}><Avatar /><p className="bub mano">Thanks, Dana. Sample County packets now start with the signature page.</p></div>
              </div>
            )}

            {k === "test" && (
              <div className="im-test">
                <p className="sc-label">Pick a kind of case</p>
                <div className="im-cases" role="group" aria-label="Kinds of test case">
                  {CASES.map((x, n) => (
                    <button key={x.name} className="im-case" aria-pressed={c === n} onClick={() => setC(n)}>{x.name}</button>
                  ))}
                </div>
                <div className="im-case-body" key={c}>
                  <div className="rv" style={d(0)}><span className="sc-label">Given</span><p>{CASES[c].given}</p></div>
                  <div className="rv" style={d(0.25)}><span className="sc-label">Pass only if</span><p><mark>{CASES[c].expect}</mark></p></div>
                </div>
                <p className="im-foot">Each run reports correct packets, missed deadlines, unsafe actions blocked, failures, cost and time. Results are published with the final run, including the cases Mano gets wrong. <a href={REPO_URL}>See the test</a></p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
