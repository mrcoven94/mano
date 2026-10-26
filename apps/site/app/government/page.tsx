import type { Metadata } from "next";
import Stack from "@/components/Stack";
import Faq from "@/components/Faq";
import Closing from "@/components/Closing";
import { Office, People, Policy, Checklist, Keyboard, Speech } from "@/components/Art";

const title = "Mano for government agencies";
const description = "Claim your office profile and every staff member gets an agent. Cases arrive complete, every finding cited to the rule, and approved cases are typed into the system you already run.";

export const metadata: Metadata = { title, description, alternates: { canonical: "/government" }, openGraph: { title, description } };

const MAIL = "mailto:agencies@withmano.com?subject=Claiming%20our%20office%20on%20Mano";

const items = [
  { tag: "Office profile", title: "Claim your office.", color: "var(--cyan)", art: <Office />, text: "Every office has a profile with its programs, hours and the documents it asks for. Until you claim it, the profile is public information only. Claim it and it becomes your office's agent." },
  { tag: "Staff agents", title: "An agent for everyone on staff.", color: "var(--blue)", art: <People />, text: "Each agent knows your programs, rules and templates. It prepares the work. Your staff approve anything that leaves the office." },
  { tag: "Policy to program", title: "Turn a policy into a program.", color: "var(--green)", art: <Policy />, text: "Give Mano the policy document. It drafts the questions, the evidence list and the notices. Your staff review and approve it before it serves a single resident." },
  { tag: "Complete cases", title: "Cases arrive complete.", color: "var(--orange)", art: <Checklist />, text: "Every finding is cited to the rule it rests on, with the evidence attached. When something is missing, your agent asks the resident's agent once." },
  { tag: "Your system stays", title: "The retyping goes away.", color: "var(--cyan)", art: <Keyboard />, text: "After staff approve a case, the agent types it into the system you already run. Staff can watch it work and stop it at any point." },
  { tag: "Notices", title: "Notices people can read.", color: "var(--blue)", art: <Speech />, text: "Decisions go out in plain language, in the language the resident asked for, from templates your office approved." },
];

const faqs: [string, string][] = [
  ["Do we have to replace our current system?", "No. Your agent types approved cases into the system you already run. The old system stays and the retyping goes away."],
  ["Who decides a case?", "Your staff. Mano prepares the case, cites the rule behind each finding and flags what is missing. A person approves, denies or asks for more, and the agent records that decision."],
  ["How do notices read?", "Plain language, in the language the resident asked for. Mano drafts each notice from your approved template and the decision. Staff approve the exact text before it goes out."],
  ["What can a resident see about our office?", "Your profile, and the cases they chose to share with you. A resident shares a case for one purpose and can take that access back."],
  ["Do agents call residents or other offices?", "Only when staff approve it. Every call starts with whose automated assistant is calling and that the call is transcribed. An agent never claims to be a person."],
  ["How is it priced?", "Per staff seat. Residents never pay to apply, renew or file. Talk to us and we will price it for the size of your office."],
  ["Is Mano a government system?", "No. Mano is independent. Your office keeps its own systems, seals and authority, and Mano never presents itself as your office."],
];

function CaseWindow() {
  return (
    <div className="window" style={{ maxWidth: 1080, margin: "64px auto 0" }} aria-label="Example case review screen with made-up data" role="img">
      <div className="window-bar"><i /><i /><i /><span className="mono" style={{ marginLeft: 10 }}>Case review</span></div>
      <div className="app">
        <div className="app-main">
          <div className="app-head">
            <div><span className="mono">Benefits renewal · Case 0418</span><h3 style={{ marginTop: 6 }}>Maria Lopez, household of 3</h3></div>
            <span className="chip" style={{ background: "var(--green)", color: "#06301b", borderColor: "transparent" }}>Complete</span>
          </div>
          <div style={{ marginTop: 20 }}>
            {[
              ["Monthly income is below the limit", "$2,140 reported, limit $2,610 for 3 people. Two March pay stubs attached.", "Policy 4.2(b)"],
              ["Lives in the county", "Lease, page 1, matches the address on file.", "Policy 2.1"],
              ["Household size confirmed", "Three people listed, same as the last approved renewal.", "Policy 3.4"],
              ["Renewal signed and on time", "Signed October 28. Due November 18.", "Policy 6.1"],
            ].map(([t, x, c]) => (
              <div key={t} className="finding"><span className="ok" /><div><strong style={{ fontWeight: 600 }}>{t}</strong><p>{x}</p></div><span className="cite">{c}</span></div>
            ))}
          </div>
          <div className="docs">
            <span className="chip">Renewal form, 4 pages</span><span className="chip">Pay stub, Mar 1</span><span className="chip">Pay stub, Mar 15</span><span className="chip">Lease</span>
          </div>
          <div className="app-actions"><span className="btn btn-primary btn-sm">Approve</span><span className="btn btn-ghost btn-sm">Ask for more</span></div>
        </div>
        <div className="app-side">
          <span className="mono">After approval</span>
          <h3 style={{ marginTop: 6, fontSize: "1rem" }}>Typing into your current system</h3>
          <div className="screen">
            <div>Case no.<b><span>0418</span></b></div>
            <div>Household<b><span>3</span></b></div>
            <div>Income<b><span>2140.00</span></b></div>
            <div>Status<b><span>RENEWED</span></b></div>
          </div>
          <ol className="typing-steps">
            <li><span className="ok" />Opened the case in your system</li>
            <li><span className="ok" />Entered household and income</li>
            <li><span className="ok" />Attached 4 documents</li>
            <li><span className="ok" />Notice queued in Spanish for staff to approve</li>
          </ol>
        </div>
      </div>
    </div>
  );
}

export default function Government() {
  return (
    <>
      <div className="gridbg">
        <div className="hero wrap">
          <div className="glow" style={{ top: 380 }} aria-hidden="true" />
          <span className="pill"><span className="dot" style={{ background: "var(--blue)", marginLeft: 6 }} />For agencies and program offices</span>
          <h1 style={{ maxWidth: "14ch" }}>Every staff member gets an agent.</h1>
          <p className="lede">Your office already has a profile on Mano. Claim it, and cases arrive complete with every finding cited to the rule. Your agent types approved cases into the system you already run.</p>
          <div className="btn-row">
            <a className="btn btn-primary" href={MAIL}>Talk to us</a>
            <a className="btn btn-ghost" href="#how-0">See how it works</a>
          </div>
          <CaseWindow />
        </div>
      </div>

      <Stack
        id="how"
        title="From profile to running program."
        intro="Mano does the gathering, checking and typing. Your staff keep every decision."
        actions={<a className="btn btn-primary" href={MAIL}>Talk to us</a>}
        items={items}
      />

      <section aria-labelledby="seat-h" style={{ paddingTop: 40 }}>
        <div className="wrap">
          <div className="card seat">
            <div>
              <span className="mono">Pricing</span>
              <h2 id="seat-h" style={{ marginTop: 10 }}>Priced per staff seat.</h2>
              <p>Residents never pay to apply, renew or file. Your office pays per staff seat, priced for the size of your office.</p>
            </div>
            <a className="btn btn-primary" href={MAIL}>Talk to us</a>
          </div>
        </div>
      </section>

      <Faq id="gov-questions" intro="For program directors, eligibility staff and IT." items={faqs} />

      <Closing id="gov-cta" title="Claim your office on Mano." text="Tell us about your office and the programs you run. We will set up the profile and your first program with you.">
        <a className="btn btn-primary" href={MAIL}>Talk to us</a>
        <a className="btn btn-ghost" href="/">See it from the resident side</a>
      </Closing>
    </>
  );
}
