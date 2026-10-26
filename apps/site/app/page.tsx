import type { Metadata } from "next";
import Image from "next/image";
import Mascot from "@/components/Mascot";
import FamilyDemo from "@/components/FamilyDemo";
import HelpTiles from "@/components/HelpTiles";
import Channels from "@/components/Channels";
import TellMano from "@/components/TellMano";
import Bundles from "@/components/Bundles";
import Everywhere from "@/components/Everywhere";
import Ladder from "@/components/Ladder";
import WatchMano from "@/components/WatchMano";
import StickyCta from "@/components/StickyCta";
import Faq from "@/components/Faq";
import Closing from "@/components/Closing";
import { SMS_HREF, SMS_NUMBER } from "@/lib/site";
import "./home.css";

export const metadata: Metadata = {
  title: { absolute: "Mano: help your family thrive" },
  description: "Mano is your family's own helper. It finds everything you can get, from food and rent to child care, health coverage, credit and job training, fills out the forms and asks before anything is sent. Then it helps you get ahead.",
  alternates: { canonical: "/" },
};

const faqs: [string, string][] = [
  ["Is Mano really free?", "Yes. Applying, renewals, deadlines, reminders and filing are free, and they stay free. Plus costs $8 a month or $60 a year and pays for things that cost money to run: phone calls, mailed and faxed letters and a priority line."],
  ["Does Mano decide if I get help?", "No. The office that runs the program decides. Mano prepares your application, sends it when you say yes, follows up and tells you what the office said."],
  ["Do I have to approve everything?", "Yes. Before anything goes out, Mano shows you who it is for, what it is for and the exact copy. If anything changes after you said yes, Mano asks you again."],
  ["Who can see my information?", "Only the people and offices you choose, for the reason you choose. You can see who has access and take it back at any time. Mano cannot pull back copies that were already sent, and it tells you which ones those are."],
  ["What happens when Mano makes a call?", "It says who it is right away: \"I'm calling for (your name). I'm their automated assistant. This call is transcribed.\" Mano never pretends to be you or to be a person."],
  ["What if a letter tells Mano to do something?", "Mano treats letters, forms and web pages as information, never as orders. It checks every link before opening it and will not open one that fails the check."],
  ["What do I need to start?", "A phone that can text. Text or iMessage Mano, or open it on the web. Apps for iPhone, Android, Mac and Windows are in early access. It is the same Mano, with the same memory, everywhere you use it."],
  ["Is Mano part of the government?", "No. Mano is independent. It deals with the offices that run programs for you, so you spend less time on the phone and in line."],
];

export default function Home() {
  return (
    <>
      <div className="hero2">
        <div className="wrap hero2-grid">
          <div className="hero2-copy">
            <Channels />
            <h1>
              <span className="hero-line">Mano <Mascot tile tone="orange" wave className="hero-tile" /></span>
              <span className="hero-sub">helps your family thrive.</span>
            </h1>
            <p className="lede">Text Mano what your family needs. It finds every program you can get for food, rent, child care, health coverage and jobs, and fills out the forms. Then it helps you get ahead, with credit, training and school.</p>
            <div className="btn-row" id="hero-cta">
              <a className="btn btn-primary btn-lg" href="#get-mano">Get Mano free</a>
              <a className="btn btn-ghost btn-lg" href="#demo-h">See how it works</a>
            </div>
            <p className="note">Free for families. Nothing is sent until you say yes.</p>
          </div>
          <div className="hero2-art">
            <HelpTiles />
            <Image src="/art/hero.svg" width={480} height={360} priority alt="Mano, a cheerful hand with a smiling face, waving and holding a phone" unoptimized />
          </div>
        </div>
      </div>

      <section className="demo-section" aria-labelledby="demo-h">
        <div className="wrap">
          <div className="section-head">
            <span className="mono eyebrow">One text</span>
            <h2 id="demo-h">Ask for one thing. Get everything you qualify for.</h2>
          </div>
          <FamilyDemo />
        </div>
      </section>

      <section aria-labelledby="work-h" className="tint">
        <div className="wrap">
          <div className="section-head">
            <span className="mono eyebrow">Watch Mano work</span>
            <h2 id="work-h">Mano does the hard parts while you live your life.</h2>
          </div>
          <WatchMano />
        </div>
      </section>

      <section aria-labelledby="ladder-h">
        <div className="wrap">
          <div className="section-head">
            <span className="mono eyebrow">More than forms</span>
            <h2 id="ladder-h">The safety net has gaps. Mano fills them.</h2>
            <p className="lede">Programs don&rsquo;t talk to each other, so families fall between them. Mano connects every piece for you and keeps going until your family is on steady ground, then helps you climb.</p>
          </div>
          <Ladder />
        </div>
      </section>

      <section aria-labelledby="ask-h">
        <div className="wrap">
          <div className="section-head">
            <span className="mono eyebrow">Tell Mano</span>
            <h2 id="ask-h">Say it the way you would say it to a friend.</h2>
          </div>
          <TellMano />
        </div>
      </section>

      <section aria-labelledby="bundle-h" className="tint">
        <div className="wrap">
          <div className="section-head">
            <span className="mono eyebrow">Your whole family</span>
            <h2 id="bundle-h">One need usually comes with others.</h2>
            <p className="lede">If you need help with rent, you probably need help with the power bill. If you have four kids and need food help, you may also need child care and a ride. Mano looks at your whole situation, so nothing gets missed.</p>
          </div>
          <Bundles />
        </div>
      </section>

      <section aria-labelledby="watch-h">
        <div className="wrap">
          <div className="section-head">
            <span className="mono eyebrow">After you apply</span>
            <h2 id="watch-h">Mano keeps watching, so you can stop worrying.</h2>
          </div>
          <div className="watch">
            <article className="card watch-card">
              <div className="art"><Image src="/art/detective.svg" width={480} height={360} alt="" unoptimized /></div>
              <h3>Renews before the deadline</h3>
              <p>Mano knows when every program needs a renewal and gets it done early, asking only what changed.</p>
            </article>
            <article className="card watch-card">
              <div className="art"><Image src="/art/plant.svg" width={480} height={360} alt="" unoptimized /></div>
              <h3>Finds new help when life changes</h3>
              <p>A new baby, a new job, a move. Tell Mano and it checks what your family can get now.</p>
            </article>
            <article className="card watch-card">
              <div className="art"><Image src="/art/hold.svg" width={480} height={360} alt="" unoptimized /></div>
              <h3>Waits on hold so you don&rsquo;t</h3>
              <p>Mano calls the office, sits through the hold music and texts you when a person picks up.</p>
            </article>
          </div>
        </div>
      </section>

      <section aria-labelledby="every-h" className="tint">
        <div className="wrap">
          <div className="section-head">
            <span className="mono eyebrow">Everywhere</span>
            <h2 id="every-h">Message Mano from anywhere.</h2>
            <p className="lede">iMessage, text, the apps for your phone and computer, or the web. Start on one, pick up on another. Same Mano, same memory.</p>
          </div>
          <Everywhere />
        </div>
      </section>

      <section aria-labelledby="net-h">
        <div className="wrap">
          <div className="section-head">
            <span className="mono eyebrow">Connected</span>
            <h2 id="net-h">When an office needs something, Mano asks you first.</h2>
          </div>
          <ol className="handoff" role="list">
            <li className="card"><span className="ho-step">1</span><span className="ho-from">Sample County</span><p className="ho-big">&ldquo;We need one pay stub from March.&rdquo;</p><p>The county asks Mano, not you, so you don't miss the letter.</p></li>
            <li className="card"><span className="ho-step">2</span><span className="ho-from">Mano</span><p className="ho-big">&ldquo;The county needs your March pay stub. Send a photo?&rdquo;</p><p>Mano tells you exactly what is needed and why.</p></li>
            <li className="card"><span className="ho-step">3</span><span className="ho-from">You</span><p className="ho-big">&ldquo;Yes.&rdquo;</p><p>Only that one page goes to the county. Nothing is shared until you say yes.</p></li>
          </ol>
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
        id="get-mano"
        art={<Image className="closing-art" src="/art/paperwork.svg" width={480} height={360} alt="" unoptimized />}
        title="Help for your whole family, in one text."
        text="Hand Mano the pile of paperwork on your counter. It will tell you what each letter says, what your family can get and what happens next."
        extra={
          <div className="steps3">
            <div><span className="mono">Step 1</span><strong>Text Mano</strong><p>Text or iMessage {SMS_NUMBER} (a placeholder until launch), or open Mano on the web.</p></div>
            <div><span className="mono">Step 2</span><strong>Send a photo or ask</strong><p>A letter, a form, or a question like &ldquo;Can I get help with rent?&rdquo;</p></div>
            <div><span className="mono">Step 3</span><strong>Say yes when it is ready</strong><p>Mano shows you the finished copy. Nothing goes out until you approve it.</p></div>
          </div>
        }
      >
        <a className="btn btn-primary" href={SMS_HREF}>Text Mano</a>
        <a className="btn btn-ghost" href="/government">For agencies</a>
      </Closing>
      <StickyCta />
    </>
  );
}
