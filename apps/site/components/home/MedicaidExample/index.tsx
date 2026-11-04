"use client";
import Link from "next/link";
import { Stage } from "@/components/stageshow";
import reading from "@/public/home/medicaid-reading.json";
import "./card.css";

/* The static-card Stageshow composition, adapted to the source paper and its
   recorded extraction. This is one real Mail read of a synthetic notice,
   not a live request, a saved deadline or an eligibility decision. Read the
   source and result together; /try runs a new document check. */
const fields = reading.fields;
const NUMBERED_ITEM = /^\d+\.\s*/;

export default function MedicaidExample() {
  return (
    <section className="h-medicaid" aria-labelledby="medicaid-h">
      <div className="wrap">
        <div className="md-intro">
          <div>
            <p className="md-eyebrow">Medicaid in 2027</p>
            <h2 id="medicaid-h">Keep your coverage when the new rules start in January.</h2>
          </div>
          <div className="md-context">
            <p>Under H.R. 1, states generally must start checking work requirements for certain adults by January 1, 2027. Exemptions apply. Most adults in the expansion group will renew every six months.</p>
            <p>CBO projects <strong>7.5 million more people uninsured in 2034</strong> from the law&rsquo;s Medicaid provisions. That is a national projection, not losses already counted.</p>
            <p className="md-sources"><a href="https://www.cms.gov/newsroom/fact-sheets/medicaid-community-engagement-requirement-certain-individuals-interim-final-rule-comment-period-cms">Work requirements</a> · <a href="https://www.hhs.gov/guidance/sites/default/files/hhs-guidance-documents/AID/cib12082025.pdf">Renewal rules</a> · <a href="https://www.cbo.gov/publication/61837">CBO estimate</a></p>
          </div>
        </div>

        <div className="md-case-head">
          <h3>A letter becomes a next step.</h3>
          <p>One recorded check on November 4, 2026. Maria, the office and the letter are made up.</p>
        </div>
        <Stage width={1040} height={620} compact={{ below: 720, width: 358, height: 820 }} className="md-example" fidelity="realistic">
          {(_, __, layout) => (
            <>
              <div className="md-paper">
                {layout === "compact" ? (
                  <>
                    <div className="md-paper-top"><span>From the synthetic letter</span><a href="/try/letters/datecheck.jpg">Open photo</a></div>
                    <p className="md-office">{fields.sender.value}</p>
                    <p className="md-source-quote">&ldquo;{fields.deadlineText.value}&rdquo;</p>
                    <p className="md-source-case">Case {fields.referenceNo.value}</p>
                  </>
                ) : (
                  <a href="/try/letters/datecheck.jpg" aria-label="Open Maria's full synthetic Medi-Cal letter">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/try/letters/datecheck.jpg" alt="Synthetic Medi-Cal renewal notice. It asks for a packet by November 20, 2026." width={1831} height={2324} loading="lazy" />
                  </a>
                )}
              </div>
              <div className="md-result">
                <div className="md-result-top">Recorded result <a href="/home/medicaid-reading.json">View extracted data</a></div>
                <div className="md-program">{fields.program.value} renewal</div>
                <p className="md-case">Case {fields.referenceNo.value}</p>
                <div className="md-date-label">Renewal date to check</div>
                <div className="md-date">November 20, 2026</div>
                <p className="md-quote">&ldquo;{fields.deadlineText.value}&rdquo;</p>
                <div className="md-evidence-title">The letter asks for</div>
                <ol className="md-evidence">
                  {fields.asked.map((field) => <li key={field.value}>{field.value.replace(NUMBERED_ITEM, "")}</li>)}
                </ol>
                <div className="md-next">
                  <strong>Check this date against your letter.</strong>
                  <span>Mano asked Maria to confirm November 20. No deadline was saved in this recorded check.</span>
                </div>
              </div>
            </>
          )}
        </Stage>
        <div className="md-bottom">
          <div>
            <p>Mano reads the notice and asks you to check the date. Medicaid forms and work reporting are not built yet. This example is not connected to a state system. The office decides eligibility.</p>
          </div>
          <Link className="btn btn-primary" href="/try#try-docs-h">Try a live document check</Link>
        </div>
      </div>
    </section>
  );
}
