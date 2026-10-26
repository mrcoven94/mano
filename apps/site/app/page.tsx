import type { Metadata } from "next";
import Mascot from "@/components/Mascot";
import Rotator from "@/components/Rotator";
import Preview from "@/components/Preview";
import Network from "@/components/Network";
import Bento from "@/components/Bento";
import Faq from "@/components/Faq";
import Closing from "@/components/Closing";
import { SMS_HREF, SMS_NUMBER, PLACEHOLDER_NOTE } from "@/lib/site";

export const metadata: Metadata = {
  title: { absolute: "Mano: Apply once, for anything that makes your life better" },
  description: "Your own agent applies for benefits, cash assistance, jobs, scholarships and training. It fills out forms, reads your mail from a photo, renews on time and waits on hold. You approve every step.",
  alternates: { canonical: "/" },
};

const phrases = [
  { text: "applies for help.", color: "var(--cyan)" },
  { text: "fills out forms.", color: "var(--blue)" },
  { text: "reads your mail.", color: "var(--orange)" },
  { text: "renews on time.", color: "var(--green)" },
  { text: "waits on hold.", color: "var(--cyan)" },
];

const faqs: [string, string][] = [
  ["Is Mano really free?", "Yes. Applying, renewals, deadlines, reminders and filing are free, and they stay free. Plus costs $8 a month or $60 a year and pays for things that cost money to run: phone calls, mailed and faxed letters and a priority line."],
  ["Does Mano decide if I get help?", "No. The office that runs the program decides. Mano prepares your application, sends it when you say yes, follows up and tells you what the office said."],
  ["Do I have to approve everything?", "Yes. Before anything goes out, Mano shows you who it is for, what it is for and the exact copy. If anything changes after you said yes, Mano asks you again."],
  ["Who can see my information?", "Only the people and offices you choose, for the reason you choose. You can see who has access and take it back at any time. Mano cannot pull back copies that were already sent, and it tells you which ones those are."],
  ["What happens when Mano makes a call?", "It says who it is right away: \"I'm calling for (your name). I'm their automated assistant. This call is transcribed.\" Mano never pretends to be you or to be a person."],
  ["What if a letter tells Mano to do something?", "Mano treats letters, forms and web pages as information, never as orders. It checks every link before opening it and will not open one that fails the check."],
  ["What do I need to start?", "A phone that can send texts. Mano works by text message, so there is no app to download."],
  ["Is Mano part of the government?", "No. Mano is independent. It deals with the offices that run programs for you, so you spend less time on the phone and in line."],
];

export default function Home() {
  return (
    <>
      <div className="gridbg">
        <div className="hero wrap">
          <div className="glow" style={{ top: 360 }} aria-hidden="true" />
          <span className="pill"><b>Free</b> Works by text. No app to download.</span>
          <h1>
            <span className="sr-only">Mano applies for help, fills out forms, reads your mail, renews on time and waits on hold.</span>
            <span aria-hidden="true" className="hero-line">Mano <Mascot tile tone="orange" wave className="hero-tile" /></span>
            <Rotator items={phrases} />
          </h1>
          <p className="lede">Your own agent for benefits, cash assistance, jobs, scholarships and training. Text it a photo of any letter or form. It does the paperwork and asks you before anything is sent.</p>
          <div className="btn-row">
            <a className="btn btn-primary" href={SMS_HREF}>Text Mano</a>
            <a className="btn btn-ghost" href="#get-started">Get started</a>
          </div>
          <p className="note">{PLACEHOLDER_NOTE}</p>
          <Preview />
        </div>
      </div>

      <section aria-labelledby="net-h">
        <div className="wrap">
          <div className="section-head">
            <span className="mono eyebrow">Connected</span>
            <h2 id="net-h">Your agent talks to theirs.</h2>
            <p className="lede">Counties and nonprofits have agents too. When an office needs a document, its agent asks yours, yours asks you, and nothing is shared until you say yes.</p>
          </div>
          <Network />
        </div>
      </section>

      <section aria-labelledby="does-h" style={{ paddingTop: 40 }}>
        <div className="wrap">
          <div className="section-head">
            <span className="mono eyebrow">What Mano does</span>
            <h2 id="does-h">Hand it the paperwork.</h2>
            <p className="lede">Everything works by text message, on any phone, in your language.</p>
          </div>
          <Bento />
        </div>
      </section>

      <section aria-labelledby="charge-h">
        <div className="wrap control">
          <div>
            <span className="mono eyebrow">You stay in charge</span>
            <h2 id="charge-h">Nothing goes out without your yes.</h2>
            <div className="points">
              {[
                ["var(--cyan)", "You approve every step", "Before anything is sent, Mano shows you who it goes to, why, and the exact copy. If the copy changes, Mano asks again."],
                ["var(--green)", "You choose who sees your case", "Share one case with one office or one case manager, for one reason. Their agent sees that case and nothing else."],
                ["var(--orange)", "You can take access back", "Remove access at any time and it stops right away. Mano tells you plainly what was already sent."],
              ].map(([c, t, x], k) => (
                <div key={t}><span className="num" style={{ background: c }}>0{k + 1}</span><div><h3>{t}</h3><p>{x}</p></div></div>
              ))}
            </div>
          </div>
          <div style={{ display: "grid", gap: 14 }} aria-hidden="true">
            <div className="card approval">
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <Mascot size={36} tile tone="orange" />
                <div><span className="mono">Ready to send</span><h3 style={{ marginTop: 2 }}>Send your renewal?</h3></div>
              </div>
              <dl>
                <div><dt>To</dt><dd>Sample County Human Services</dd></div>
                <div><dt>For</dt><dd>Benefits renewal</dd></div>
                <div><dt>Copy</dt><dd>Renewal form, 4 pages <span className="hash">version 2</span></dd></div>
              </dl>
              <div className="ask" style={{ marginTop: 0 }}><span className="yes">Yes, send it</span><span className="no">Not yet</span></div>
            </div>
            <div className="card approval access">
              <span className="mono">Who can see your case</span>
              <div className="mini" style={{ maxWidth: "none" }}>
                <div className="mini-row"><span><span className="dot" style={{ background: "var(--blue)" }} /><span>County office <small>Renewal only</small></span></span><button tabIndex={-1}>Remove</button></div>
                <div className="mini-row"><span><span className="dot" style={{ background: "var(--green)" }} /><span>Your case manager <small>Renewal only</small></span></span><button tabIndex={-1}>Remove</button></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="pricing" aria-labelledby="pricing-h" className="center">
        <div className="wrap">
          <span className="mono eyebrow">What it costs</span>
          <div className="zero" aria-hidden="true">$0</div>
          <h2 id="pricing-h" style={{ marginTop: 8 }}>Free to apply. Free to renew.</h2>
          <p className="lede narrow" style={{ marginTop: 16, maxWidth: 560 }}>Applying, renewals, deadlines, reminders and filing are free, and they stay free. Nothing you need to keep your help is behind a paid plan.</p>
          <div className="plans">
            <article className="card plan">
              <h3>Free</h3>
              <div className="price">$0 <small>forever</small></div>
              <ul>
                <li>Applying for programs, jobs and scholarships</li>
                <li>Renewals and deadlines</li>
                <li>Reminders before anything is due</li>
                <li>Reading your mail from a photo</li>
                <li>Filling out and filing forms</li>
              </ul>
            </article>
            <article className="card plan plus">
              <h3>Plus</h3>
              <div className="price">$8 <small>a month, or $60 a year</small></div>
              <ul>
                <li>Everything in Free</li>
                <li>Phone calls for you, including waiting on hold</li>
                <li>Letters mailed and faxed for you</li>
                <li>A priority line when you need a person fast</li>
              </ul>
            </article>
          </div>
        </div>
      </section>

      <Faq intro="Short answers about cost, approvals, privacy and calls." items={faqs} />

      <Closing
        id="get-started"
        title="Apply once, for anything that makes your life better."
        text="Text Mano a photo of the letter on your counter. It will tell you what the letter says and what happens next."
        extra={
          <div className="steps3">
            <div><span className="mono">Step 1</span><strong>Text Mano</strong><p>Send any message to {SMS_NUMBER} (a placeholder until launch). There is no app to download.</p></div>
            <div><span className="mono">Step 2</span><strong>Send a photo or ask</strong><p>A letter, a form, or a question like &ldquo;Can I get help with rent?&rdquo;</p></div>
            <div><span className="mono">Step 3</span><strong>Say yes when it is ready</strong><p>Mano shows you the finished copy. Nothing goes out until you approve it.</p></div>
          </div>
        }
      >
        <a className="btn btn-primary" href={SMS_HREF}>Text Mano</a>
        <a className="btn btn-ghost" href="/government">For agencies</a>
      </Closing>
    </>
  );
}
