import type { Metadata } from "next";
import Link from "next/link";
import Mascot from "@/components/Mascot";
import Faq from "@/components/Faq";

export const metadata: Metadata = {
  title: "Mano for government agencies",
  description: "Claim your office profile and give every staff member their own agent. Cases arrive complete with every finding cited to the rule, and approved cases are typed into your existing system.",
};

const stack = [
  { n: "01", color: "#67e8f9", title: "Every office has a profile", text: "Your office already has a labeled profile with its programs, hours and required documents. The profile is public information only. It cannot converse, request records or send notices until you claim it." },
  { n: "02", color: "#7cb3ff", title: "Claim it, and staff get agents", text: "Claiming the profile turns it into your organization agent. Every staff member gets their own agent with your programs, rules and templates built in. Staff approve every outside action their agent prepares." },
  { n: "03", color: "#5eeaa0", title: "Turn policy into a running program", text: "Give Mano a policy document. Mano drafts the program: eligibility questions, required evidence and notices. A person on your staff reviews and approves it before it serves a single resident." },
  { n: "04", color: "#ffb26b", title: "Cases arrive complete", text: "Applications show up with the evidence attached and every finding cited to the rule it rests on. Staff see what is missing before they open a case, and residents get asked once, through their own agent." },
];

const faqs: [string, string][] = [
  ["Do we have to replace our current system?", "No. Your agent types approved cases into the system you already run. The old system stays. The retyping goes away."],
  ["Who makes the decision on a case?", "Your staff. Mano prepares the case, cites the rule for each finding and flags what is missing. A person approves, denies or asks for more, and the agent records that decision."],
  ["How do notices read for residents?", "Plain language, in the language the resident asked for. Mano drafts the notice from your approved template and your decision. Staff approve the exact text before it goes out."],
  ["What does a resident see about us?", "Residents see your claimed office profile and the cases they chose to share with you. A resident shares a case for a specific purpose and can take that access back."],
  ["How is this priced?", "Per staff seat. Residents always use Mano for free. Talk to us and we will price it for your office size."],
  ["Is Mano a government system?", "No. Mano is an independent service. Your office keeps its own systems, seals and authority. Mano never presents itself as your office."],
];

export default function Government() {
  return (
    <>
      <div className="gridbg">
        <div className="wrap" style={{ position: "relative", padding: "84px 24px 56px" }}>
          <p className="pill"><span className="dot" style={{ background: "var(--blue)" }} /> For agencies and program offices</p>
          <h1 style={{ marginTop: 22, maxWidth: 820 }}>Your office, claimed. Every staff member gets an agent.</h1>
          <p className="lede" style={{ marginTop: 20 }}>Cases arrive complete, with every finding cited to the rule. Approved cases get typed into the system you already have. Your staff stop retyping and start deciding.</p>
          <div style={{ display: "flex", gap: 12, marginTop: 30, flexWrap: "wrap" }}>
            <a className="btn btn-primary" href="mailto:agencies@withmano.com?subject=Claiming%20our%20office%20profile">Talk to us</a>
            <Link className="btn btn-ghost" href="/">See Mano for residents</Link>
          </div>
        </div>
      </div>

      <section aria-labelledby="how-h" style={{ paddingTop: 32 }}>
        <div className="wrap">
          <p className="mono">How it works</p>
          <h2 id="how-h" style={{ marginTop: 10, maxWidth: 640 }}>From profile to running program.</h2>
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

      <section aria-labelledby="day-h">
        <div className="wrap">
          <p className="mono">In the workday</p>
          <h2 id="day-h" style={{ marginTop: 10, maxWidth: 680 }}>What changes for your staff.</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 14, marginTop: 36 }}>
            {[
              ["Complete cases, cited findings", "Each application lists the evidence and the rule behind every finding. Staff verify instead of hunting through uploads."],
              ["One request for what is missing", "Your agent asks the resident's agent for the missing document. The resident approves the share. Nobody mails a second letter asking for the same page."],
              ["Typed into your existing system", "After a staff member approves a case, the agent enters it into your current system by computer. Staff watch it happen and can stop it at any point."],
              ["Notices people can read", "Decisions go out in plain language and in the resident's language, from templates your office approved."],
              ["Calls that identify themselves", "When an agent calls a resident or another office, it says whose automated assistant it is and that the call is transcribed. It never claims to be a person."],
              ["An audit trail by default", "Every prepared action, approval and send is logged with the exact document version that was approved."],
            ].map(([t, x]) => (
              <article key={t} className="card"><h3>{t}</h3><p style={{ marginTop: 8, fontSize: ".94rem" }}>{x}</p></article>
            ))}
          </div>
        </div>
      </section>

      <section aria-labelledby="price-h" style={{ paddingTop: 20 }}>
        <div className="wrap">
          <div className="card" style={{ padding: "40px 32px", display: "flex", gap: 32, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ maxWidth: 560 }}>
              <p className="mono">Pricing</p>
              <h2 id="price-h" style={{ marginTop: 10, fontSize: "1.8rem" }}>Priced per staff seat.</h2>
              <p style={{ marginTop: 10 }}>Residents never pay to apply, renew or file. Your office pays per staff seat, based on office size and call volume.</p>
            </div>
            <a className="btn btn-primary" href="mailto:agencies@withmano.com?subject=Mano%20for%20our%20agency">Talk to us</a>
          </div>
        </div>
      </section>

      <section aria-labelledby="gfaq-h" style={{ paddingTop: 20 }}>
        <div className="wrap" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 40 }}>
          <div><p className="mono">Questions</p><h2 id="gfaq-h" style={{ marginTop: 10 }}>For agency staff.</h2><div style={{ marginTop: 24 }} aria-hidden="true"><Mascot size={84} /></div></div>
          <Faq items={faqs} />
        </div>
      </section>
    </>
  );
}
