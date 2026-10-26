import type { Metadata } from "next";
import Link from "next/link";
import Mascot from "@/components/Mascot";
import Faq from "@/components/Faq";

export const metadata: Metadata = {
  title: "Mano for nonprofits and case managers",
  description: "Every case manager gets an agent that knows their caseload, prepares the paperwork and chases documents. Launch a cash assistance program and offer partner extensions residents can turn on.",
};

const stack = [
  { n: "01", color: "#67e8f9", title: "An agent that knows the caseload", text: "Each case manager gets an agent loaded with their cases, deadlines and program rules. The agent prepares renewals and applications from the case file and shows the manager the exact draft before anything moves." },
  { n: "02", color: "#7cb3ff", title: "Paperwork prepared, documents chased", text: "When a case needs a pay stub or a signed form, the manager's agent asks the resident's agent. The resident approves the share. The chase happens between agents, and the manager sees status instead of making reminder calls." },
  { n: "03", color: "#5eeaa0", title: "Launch a cash assistance program", text: "Describe the program and give Mano the rules. Mano drafts the application, the evidence list and the notices. Your team reviews and approves, then residents apply through their own Mano." },
  { n: "04", color: "#ffb26b", title: "Extensions residents can turn on", text: "A marketplace of partner extensions adds services like document scanning or appointment booking. An extension states the exact data it asks for and who pays. The resident turns it on, approves each use and can remove it." },
];

const faqs: [string, string][] = [
  ["What does a case manager actually do in Mano?", "Review and approve. The agent prepares applications, renewals and document requests from the caseload. The manager checks the exact draft, approves it and handles the conversations only a person can handle."],
  ["Can we run our own assistance program?", "Yes. You set the rules and the budget. Mano turns them into an application residents can complete by text, photo or form, and prepares each case for your review."],
  ["How do residents share cases with us?", "A resident shares a case with your organization for a specific purpose. Your case manager's agent sees only that case. The resident can take the share back at any time."],
  ["What are partner extensions?", "Outside services that plug into Mano. Each one lists the data it needs and who pays for it. Residents approve each extension and each use. Mano never sells personal data."],
  ["How is this priced?", "Per seat, for each case manager. Residents always use Mano for free. Talk to us for pricing at your team size."],
  ["Does Mano replace case managers?", "No. Mano does the gathering, drafting and chasing. Case managers keep the relationships, the judgment calls and every approval."],
];

export default function Organizations() {
  return (
    <>
      <div className="gridbg">
        <div className="wrap" style={{ position: "relative", padding: "84px 24px 56px" }}>
          <p className="pill"><span className="dot" style={{ background: "var(--green)" }} /> For nonprofits and case managers</p>
          <h1 style={{ marginTop: 22, maxWidth: 820 }}>Every case manager gets an agent that knows their caseload.</h1>
          <p className="lede" style={{ marginTop: 20 }}>The agent prepares the paperwork, chases the missing documents and keeps every deadline in view. Your team spends its time with people.</p>
          <div style={{ display: "flex", gap: 12, marginTop: 30, flexWrap: "wrap" }}>
            <a className="btn btn-primary" href="mailto:organizations@withmano.com?subject=Mano%20for%20our%20team">Talk to us</a>
            <Link className="btn btn-ghost" href="/">See Mano for residents</Link>
          </div>
        </div>
      </div>

      <section aria-labelledby="ohow-h" style={{ paddingTop: 32 }}>
        <div className="wrap">
          <p className="mono">How it works</p>
          <h2 id="ohow-h" style={{ marginTop: 10, maxWidth: 640 }}>From caseload to launched program.</h2>
          <div style={{ marginTop: 40, display: "grid", gap: 14, maxWidth: 860 }}>
            {stack.map((s, i) => (
              <article key={s.n} className="stackcard" style={{ top: 100 + i * 12, background: `color-mix(in srgb, ${s.color} 7%, #1c1c1c)` }}>
                <p className="mono" style={{ color: s.color }}>{s.n}</p>
                <h3 style={{ marginTop: 10, fontSize: "1.35rem" }}>{s.title}</h3>
                <p style={{ marginTop: 8, maxWidth: 640 }}>{s.text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section aria-labelledby="oweek-h">
        <div className="wrap">
          <p className="mono">In the week</p>
          <h2 id="oweek-h" style={{ marginTop: 10, maxWidth: 680 }}>What the agent takes off the list.</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 14, marginTop: 36 }}>
            {[
              ["Renewals drafted ahead", "The agent sees a renewal coming, pulls the case file and drafts the packet. The manager reviews one draft instead of rebuilding the case."],
              ["Documents chased between agents", "Missing evidence goes out as one clear request to the resident's agent. Replies land in the case file, matched to the requirement."],
              ["Deadlines in one view", "Every case deadline across the caseload, sorted by what is due first, with the owner of the next step named."],
              ["Programs you can launch", "Turn your assistance rules into a working application without hiring engineers or buying a portal."],
              ["Extensions with clear terms", "Each extension in the marketplace states what data it uses and who pays. Residents opt in. Your team sees which extensions a case uses."],
              ["Approvals stay human", "Sends, shares and submissions wait for a named person's approval, bound to the exact document version."],
            ].map(([t, x]) => (
              <article key={t} className="card"><h3>{t}</h3><p style={{ marginTop: 8, fontSize: ".94rem" }}>{x}</p></article>
            ))}
          </div>
        </div>
      </section>

      <section aria-labelledby="oprice-h" style={{ paddingTop: 20 }}>
        <div className="wrap">
          <div className="card" style={{ padding: "40px 32px", display: "flex", gap: 32, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ maxWidth: 560 }}>
              <p className="mono">Pricing</p>
              <h2 id="oprice-h" style={{ marginTop: 10, fontSize: "1.8rem" }}>Priced per seat.</h2>
              <p style={{ marginTop: 10 }}>One seat per case manager. Residents never pay to apply, renew or file. Pricing scales with team size and program volume.</p>
            </div>
            <a className="btn btn-primary" href="mailto:organizations@withmano.com?subject=Mano%20for%20our%20organization">Talk to us</a>
          </div>
        </div>
      </section>

      <section aria-labelledby="ofaq-h" style={{ paddingTop: 20 }}>
        <div className="wrap" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 40 }}>
          <div><p className="mono">Questions</p><h2 id="ofaq-h" style={{ marginTop: 10 }}>For nonprofit teams.</h2><div style={{ marginTop: 24 }} aria-hidden="true"><Mascot size={84} /></div></div>
          <Faq items={faqs} />
        </div>
      </section>
    </>
  );
}
