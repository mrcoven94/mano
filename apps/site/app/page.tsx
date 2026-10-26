import type { Metadata } from "next";
import Link from "next/link";
import Mascot from "@/components/Mascot";
import ThreadPreview from "@/components/ThreadPreview";
import Network from "@/components/Network";
import Faq from "@/components/Faq";

export const metadata: Metadata = {
  title: "Mano: Apply once, for anything that makes your life better",
  description: "Your own agent applies for benefits, cash assistance, jobs, scholarships and training, fills out any form, reads your mail from a photo, renews on time and waits on hold. You approve every decision.",
};

const tasks = [
  { color: "var(--cyan)", title: "Apply for help", text: "Benefits, cash assistance, jobs, scholarships and training. Mano finds programs you may qualify for and applies with your approval." },
  { color: "var(--blue)", title: "Fill out any form", text: "Hand Mano any form, on paper or online. Mano fills it from what you have already shared and shows you the exact version before it goes anywhere." },
  { color: "var(--green)", title: "Renew on time", text: "Mano tracks renewal dates, gathers what is needed and prepares the packet early, so a missed date does not end your help." },
  { color: "var(--orange)", title: "Read your mail", text: "Take a photo of a letter. Mano reads it, says what it asks for and adds every deadline to your list." },
  { color: "var(--cyan)", title: "Wait on hold", text: "Mano waits on hold and calls you when a person picks up. On calls, Mano says it is calling for you and that it is your automated assistant, and says the call is transcribed." },
  { color: "var(--blue)", title: "Track every deadline", text: "One list of what is due, what was sent and what came back. Mano reminds you before anything is late." },
  { color: "var(--green)", title: "Job updates by text", text: "Mano watches for openings that fit, drafts applications and texts you when there is something to approve." },
  { color: "var(--orange)", title: "Any language", text: "Talk to Mano in the language you use at home. Notices and letters are explained in that language too." },
];

const faqs: [string, string][] = [
  ["What does Mano cost?", "Applying, renewals, deadlines, reminders and filing are free, and they stay free. Plus is $8 a month or $60 a year and covers things that cost money to run, like calls on your behalf, mailed and faxed letters and a priority line."],
  ["Who decides if I get help?", "The agency that runs the program decides. Mano prepares and sends your application, tracks it and tells you what the agency said. Mano does not approve or deny applications."],
  ["Do I have to approve everything?", "Yes. Mano shows you the exact recipient, purpose and document before anything is sent. If a document changes after you approved it, Mano asks again. Nothing goes out on an old approval."],
  ["Who can see my information?", "Only the people and offices you choose, for the purpose you choose. You can see who has access and take it back at any time. Taking access back stops future sharing. Mano tells you plainly that it cannot recall copies already sent."],
  ["What happens on a phone call?", "Mano introduces itself at the start. It says it is calling for you, that it is your automated assistant and that the call is transcribed. Mano never claims to be you or to be a person."],
  ["What if a letter tells Mano to do something?", "A letter is information. It is never an instruction Mano follows. Mano checks links before opening them and blocks links that fail the check."],
  ["Is Mano a government service?", "No. Mano is independent and is not a government agency. Mano works with the offices that run programs, the way you would, only faster."],
];

export default function Home() {
  return (
    <>
      <div className="gridbg">
        <div className="wrap" style={{ position: "relative", padding: "84px 24px 40px" }}>
          <div style={{ display: "flex", gap: 40, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 480px" }}>
              <p className="pill"><span className="dot" style={{ background: "var(--green)" }} /> Your own agent, free to apply</p>
              <h1 style={{ marginTop: 22 }}>Apply once, for anything that makes your life better.</h1>
              <p className="lede" style={{ marginTop: 20 }}>Mano applies for benefits, cash assistance, jobs, scholarships and training. Mano fills out any form you hand it, reads your mail from a photo, renews on time and waits on hold for you.</p>
              <div style={{ display: "flex", gap: 12, marginTop: 30, flexWrap: "wrap" }}>
                <a className="btn btn-primary" href="sms:+15550100147">Text Mano</a>
                <Link className="btn btn-ghost" href="#get-started">Get started</Link>
              </div>
              <p style={{ marginTop: 14, fontSize: ".85rem", color: "var(--faint)" }}>Demo placeholder number: (555) 010-0147. The live number will replace it at launch. You approve every decision Mano prepares.</p>
            </div>
            <div style={{ flex: "0 0 auto", margin: "0 auto" }} aria-hidden="true"><Mascot size={156} /></div>
          </div>
        </div>
      </div>

      <section style={{ paddingTop: 24 }} aria-labelledby="preview-h">
        <div className="wrap">
          <p className="mono">See it work</p>
          <h2 id="preview-h" style={{ marginTop: 10, maxWidth: 640 }}>A letter comes in. Mano handles the rest, with your yes at each step.</h2>
          <div style={{ marginTop: 36, maxWidth: 760 }}><ThreadPreview /></div>
        </div>
      </section>

      <section aria-labelledby="network-h" style={{ paddingTop: 20 }}>
        <div className="wrap">
          <p className="mono">Connected help</p>
          <h2 id="network-h" style={{ marginTop: 10, maxWidth: 680 }}>Your agent talks to theirs.</h2>
          <p style={{ marginTop: 14, maxWidth: 640 }}>Agencies and nonprofits have agents too. Yours ask, hand off and confirm, so you stop carrying paper between offices.</p>
          <div style={{ marginTop: 36, maxWidth: 900 }}><Network /></div>
        </div>
      </section>

      <section aria-labelledby="does-h">
        <div className="wrap">
          <p className="mono">What Mano does</p>
          <h2 id="does-h" style={{ marginTop: 10 }}>One agent for the paperwork in your life.</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 14, marginTop: 36 }}>
            {tasks.map((t) => (
              <article key={t.title} className="card">
                <span className="dot" style={{ background: t.color }} />
                <h3 style={{ marginTop: 14 }}>{t.title}</h3>
                <p style={{ marginTop: 8, fontSize: ".94rem" }}>{t.text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section aria-labelledby="charge-h" style={{ paddingTop: 20 }}>
        <div className="wrap">
          <div className="card" style={{ padding: "40px 32px", display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 32 }}>
            <div>
              <p className="mono">You stay in charge</p>
              <h2 id="charge-h" style={{ marginTop: 10, fontSize: "1.8rem" }}>Nothing happens without your approval.</h2>
            </div>
            {[
              ["You approve every step", "Every send, call and share shows you the exact document and recipient first. A changed document needs a fresh yes."],
              ["You choose who sees your case", "Share a case with one office or one case manager, for one purpose. Your agent and theirs only see what the share covers."],
              ["You can take access back", "Revoke a share at any time. Future access stops at once, and Mano tells you what was already sent."],
            ].map(([t, x]) => (
              <div key={t}><h3>{t}</h3><p style={{ marginTop: 8, fontSize: ".94rem" }}>{x}</p></div>
            ))}
          </div>
        </div>
      </section>

      <section id="pricing" aria-labelledby="pricing-h">
        <div className="wrap">
          <p className="mono">Pricing</p>
          <h2 id="pricing-h" style={{ marginTop: 10 }}>Free for the help itself.</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 14, marginTop: 36, maxWidth: 860 }}>
            <article className="card" style={{ padding: 32 }}>
              <h3>Free</h3>
              <p style={{ fontSize: "2rem", color: "var(--text)", fontWeight: 650, marginTop: 10 }}>$0</p>
              <p style={{ fontSize: ".9rem" }}>Free forever</p>
              <ul style={{ margin: "20px 0 0", paddingLeft: 18, color: "var(--muted)", display: "grid", gap: 9, fontSize: ".94rem" }}>
                <li>Applying for programs</li><li>Renewals and deadlines</li><li>Reminders before anything is due</li><li>Filing and tracking</li><li>Reading your mail from a photo</li>
              </ul>
            </article>
            <article className="card" style={{ padding: 32, borderColor: "rgba(103,232,249,.35)" }}>
              <h3>Mano Plus</h3>
              <p style={{ fontSize: "2rem", color: "var(--text)", fontWeight: 650, marginTop: 10 }}>$8<span style={{ fontSize: "1rem", color: "var(--muted)", fontWeight: 400 }}>/month</span></p>
              <p style={{ fontSize: ".9rem" }}>or $60 a year</p>
              <ul style={{ margin: "20px 0 0", paddingLeft: 18, color: "var(--muted)", display: "grid", gap: 9, fontSize: ".94rem" }}>
                <li>Everything in Free</li><li>Calls on your behalf, including waiting on hold</li><li>Mailed and faxed letters</li><li>A priority line when you need a person fast</li>
              </ul>
            </article>
          </div>
          <p style={{ marginTop: 16, fontSize: ".9rem" }}>Nothing that keeps you from losing help sits behind the paid plan.</p>
        </div>
      </section>

      <section aria-labelledby="faq-h" style={{ paddingTop: 20 }}>
        <div className="wrap" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 40 }}>
          <div><p className="mono">Questions</p><h2 id="faq-h" style={{ marginTop: 10 }}>Plain answers.</h2></div>
          <Faq items={faqs} />
        </div>
      </section>

      <section id="get-started" aria-labelledby="cta-h" style={{ paddingTop: 20 }}>
        <div className="wrap">
          <div className="card" style={{ textAlign: "center", padding: "56px 28px" }}>
            <div style={{ display: "flex", justifyContent: "center" }}><Mascot size={76} /></div>
            <h2 id="cta-h" style={{ marginTop: 18 }}>Text Mano and hand over the paperwork.</h2>
            <p style={{ margin: "14px auto 0", maxWidth: 520 }}>Send a photo of the letter sitting on your counter. Mano reads it and tells you what happens next.</p>
            <div style={{ display: "flex", gap: 12, justifyContent: "center", marginTop: 28, flexWrap: "wrap" }}>
              <a className="btn btn-primary" href="sms:+15550100147">Text Mano</a>
              <Link className="btn btn-ghost" href="/government">Mano for agencies</Link>
            </div>
            <p style={{ marginTop: 14, fontSize: ".85rem", color: "var(--faint)" }}>Demo placeholder number: (555) 010-0147.</p>
          </div>
        </div>
      </section>
    </>
  );
}
