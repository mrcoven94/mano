import type { Metadata } from "next";
import Stack from "@/components/Stack";
import Faq from "@/components/Faq";
import Closing from "@/components/Closing";
import { Folder, Chase, Coins, Puzzle, People } from "@/components/Art";

const title = "Mano for nonprofits and case managers";
const description = "Every case manager gets an agent that knows their caseload, prepares the paperwork and chases documents. Launch and run a cash assistance program. Priced per seat.";

export const metadata: Metadata = { title, description, alternates: { canonical: "/organizations" }, openGraph: { title, description } };

const MAIL = "mailto:organizations@withmano.com?subject=Mano%20for%20our%20team";

const items = [
  { tag: "Caseload agent", title: "It starts from the case file.", color: "var(--green)", art: <Folder />, text: "Each case manager gets an agent with their cases, deadlines and program rules. It drafts renewals and applications from the case file and shows the manager the exact draft." },
  { tag: "Documents", title: "Documents, chased for you.", color: "var(--cyan)", art: <Chase />, text: "When a case needs a pay stub or a signed form, the manager's agent asks the resident's agent. The resident approves the share, and it lands in the case file matched to the requirement." },
  { tag: "Cash assistance", title: "Launch a cash program.", color: "var(--orange)", art: <Coins />, text: "Give Mano your rules and budget. It drafts the application, the evidence list and the notices. Your team approves them, then residents apply by text through their own Mano." },
  { tag: "Extensions", title: "Extensions residents turn on.", color: "var(--blue)", art: <Puzzle />, text: "Partner extensions add services like appointment booking or document scanning. Each one states the data it uses and who pays. Residents turn it on, approve each use and can remove it." },
  { tag: "People first", title: "Time back for people.", color: "var(--green)", art: <People />, text: "The agent does the gathering, drafting and reminding. Case managers keep the relationships, the judgment calls and every approval." },
];

const faqs: [string, string][] = [
  ["What does a case manager do in Mano?", "Review and approve. The agent prepares applications, renewals and document requests from the caseload. The manager checks the exact draft, approves it and handles the conversations only a person can."],
  ["Can we run our own assistance program?", "Yes. You set the rules and the budget. Mano turns them into an application residents can complete by text, photo or form, and prepares each case for your review."],
  ["How do residents share cases with us?", "A resident shares a case with your organization for one purpose. Your case manager's agent sees only that case, and the resident can take the share back at any time."],
  ["What are partner extensions?", "Outside services that plug into Mano. Each one lists the data it needs and who pays for it. Residents approve each extension and each use. Mano never sells personal data."],
  ["How is it priced?", "Per seat, one for each case manager. Residents never pay to apply, renew or file. Talk to us for pricing at your team size."],
  ["Does Mano replace case managers?", "No. Mano does the paperwork around the work. Case managers keep the relationships, the judgment calls and every approval."],
];

const cases = [
  ["R. Alvarez", "Benefits renewal", "Draft ready for your review", "var(--orange)", "Due Nov 18"],
  ["J. Chen", "Rent assistance", "Pay stub requested from their agent", "var(--cyan)", "Asked 1 day ago"],
  ["T. Okafor", "Cash assistance", "Approved, notice sent in English", "var(--green)", "Done"],
  ["S. Nguyen", "Job training grant", "Two documents in, one to go", "var(--blue)", "Due Dec 2"],
  ["M. Lopez", "Benefits renewal", "Sent, county confirmed receipt", "var(--green)", "Done"],
];

function CaseloadWindow() {
  return (
    <div className="window" style={{ maxWidth: 1080, margin: "64px auto 0" }} role="img" aria-label="Example caseload screen with made-up people">
      <div className="window-bar"><i /><i /><i /><span className="mono" style={{ marginLeft: 10 }}>Your caseload</span></div>
      <div className="app">
        <div className="app-main">
          <div className="app-head">
            <div><span className="mono">This week</span><h3 style={{ marginTop: 6 }}>5 cases need you, 2 are done</h3></div>
            <span className="chip"><span className="dot" style={{ background: "var(--orange)" }} />1 draft to review</span>
          </div>
          <table className="caseload">
            <thead><tr><th>Person</th><th className="hide-sm">Program</th><th>Next step</th><th className="hide-sm">When</th></tr></thead>
            <tbody>
              {cases.map(([n, p, s, c, w]) => (
                <tr key={n}>
                  <td>{n}</td>
                  <td className="hide-sm" style={{ color: "var(--muted)" }}>{p}</td>
                  <td><span style={{ display: "inline-flex", gap: 8, alignItems: "baseline" }}><span className="dot" style={{ background: c }} />{s}</span></td>
                  <td className="hide-sm" style={{ color: "var(--faint)", whiteSpace: "nowrap" }}>{w}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="app-side">
          <span className="mono">Agent activity</span>
          <ol className="typing-steps">
            <li><span className="ok" />Drafted R. Alvarez&rsquo;s renewal from the case file</li>
            <li><span className="ok" />Asked J. Chen&rsquo;s agent for a March pay stub</li>
            <li><span className="ok" />Matched S. Nguyen&rsquo;s lease to the residency rule</li>
            <li><span className="ok" />Waiting on you for one approval</li>
          </ol>
          <div className="card" style={{ marginTop: 20, padding: 16 }}>
            <span className="mono">Ready for you</span>
            <p style={{ color: "var(--text)", fontSize: ".9rem", marginTop: 6 }}>R. Alvarez renewal, 4 pages. Send to the county?</p>
            <div className="ask"><span className="yes">Approve</span><span className="no">Open draft</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Organizations() {
  return (
    <>
      <div className="gridbg">
        <div className="hero wrap">
          <div className="glow" style={{ top: 380 }} aria-hidden="true" />
          <span className="pill"><span className="dot" style={{ background: "var(--green)", marginLeft: 6 }} />For nonprofits and case managers</span>
          <h1 style={{ maxWidth: "15ch" }}>An agent that knows your caseload.</h1>
          <p className="lede">Every case manager gets one. It prepares the paperwork, chases missing documents and keeps every deadline in view, so your team spends its time with people.</p>
          <div className="btn-row">
            <a className="btn btn-primary" href={MAIL}>Talk to us</a>
            <a className="btn btn-ghost" href="#team-0">See how it works</a>
          </div>
          <CaseloadWindow />
        </div>
      </div>

      <Stack
        id="team"
        title="From caseload to a launched program."
        intro="Your team approves every send, share and submission. The agent does the rest."
        actions={<a className="btn btn-primary" href={MAIL}>Talk to us</a>}
        items={items}
      />

      <section aria-labelledby="oseat-h" style={{ paddingTop: 40 }}>
        <div className="wrap">
          <div className="card seat">
            <div>
              <span className="mono">Pricing</span>
              <h2 id="oseat-h" style={{ marginTop: 10 }}>Priced per seat.</h2>
              <p>One seat for each case manager. Residents never pay to apply, renew or file.</p>
            </div>
            <a className="btn btn-primary" href={MAIL}>Talk to us</a>
          </div>
        </div>
      </section>

      <Faq id="org-questions" intro="For program leads and case managers." items={faqs} />

      <Closing id="org-cta" title="Give your case managers their week back." text="Tell us about your team and your programs. We will set up your caseload agents with you.">
        <a className="btn btn-primary" href={MAIL}>Talk to us</a>
        <a className="btn btn-ghost" href="/">See it from the resident side</a>
      </Closing>
    </>
  );
}
