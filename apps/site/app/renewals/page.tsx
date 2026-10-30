import type { Metadata } from "next";
import Link from "next/link";
import Faq from "@/components/Faq";
import InView from "@/components/InView";
import Mascot from "@/components/Mascot";
import TextQr from "@/components/TextQr";
import { NeedIcon } from "@/components/home/NeedIcons";
import LetterDemo from "@/components/renewals/LetterDemo";
import ApprovalCard from "@/components/renewals/ApprovalCard";
import { PLACEHOLDER_NOTE, SMS_HREF, SMS_IS_PLACEHOLDER, SMS_NUMBER } from "@/lib/site";
import "./renewals.css";

const title = "Keep your benefits: renewals";
const description = "Your renewal letter came. Text Mano a photo of it. Mano reads the date, asks before it holds it, reminds you and fills out the form, and nothing is sent without your yes.";

export const metadata: Metadata = { title, description, alternates: { canonical: "/renewals" }, openGraph: { title, description } };

/* What Mano does today at each small moment where a renewal goes wrong. */
const MOMENTS: { icon: string; tint: string; title: string; text: string }[] = [
  { icon: "calendar", tint: "#DCE3FB", title: "The letter never comes, or gets lost", text: "Mano keeps every date from the letters you send it and texts you before each one. A late or lost letter is not your only reminder." },
  { icon: "clipboard", tint: "#FFF4B8", title: "The form wants everything again", text: "Mano fills out the renewal from what you already sent and shows where each answer came from. You check it and sign it." },
  { icon: "app", tint: "#FDEBD8", title: "The proof is blurry or does not arrive", text: "If a page is too blurry to read, Mano says so and asks for a new photo instead of guessing. After it sends, it checks that the office got it." },
  { icon: "pencil", tint: "#E4F1E8", title: "Something changed", text: "Tell Mano once. It updates the form, shows you exactly what changed and asks for your yes again." },
  { icon: "chat", tint: "#FDE3DA", title: "The answer is no", text: "Mano reads the letter, tells you the reason in plain words and holds the date you have to respond by." },
];

const PROMISES: [string, string][] = [
  ["Nothing is sent without your yes.", "Mano shows who it is for, why and the exact pages first."],
  ["A change makes it ask again.", "Your yes covers one exact copy. Change a word and Mano asks again."],
  ["A failed send is checked before it is retried.", "If the office site stops answering, Mano checks whether it arrived, so nothing is filed twice."],
  ["A letter is information, never instructions.", "Mano reads letters for dates and facts. It does not do what a letter tells it to."],
];

const faqs: [string, string][] = [
  ["Does Mano cost anything?", "Keeping your help is always free. Reading your letters, holding dates, reminders and renewals have no limits and need no card. Pricing on the home page shows what Plus adds."],
  ["Do I need an app?", "No. Text Mano from any phone that can text. You can also use Mano on the web."],
  ["Is it safe to give Mano my Social Security number?", "Mano never asks for it through a link. When a form needs it, the form goes out only after you see it and say yes. If a text or letter asks for it at a link, send it to Mano first and it will check."],
  ["Will Mano send anything without asking me?", "No. Mano shows you who it is for, why and the exact pages, and waits for your yes. If anything changes after that, it asks again."],
];

const d = (s: number) => ({ "--d": `${s}s` }) as React.CSSProperties;

export default function Renewals() {
  return (
    <div className="home rw">
      <div className="h-hero rw-hero">
        <div className="wrap h-hero-head">
          <h1>Your renewal is due. <mark className="rw-hl">Keep your benefits coming.</mark></h1>
          <p className="h-lede">Food benefits, health coverage, help with the power bill. Text Mano a photo of the letter.</p>
          <div className="btn-row h-ctas">
            <a className="btn btn-primary btn-lg" href={SMS_HREF}>Text Mano</a>
            <a className="btn btn-ghost btn-lg" href="#letter">How it works</a>
          </div>
          <p className="h-note">Keeping your help is always free. No card, no sign up. Just text.</p>
        </div>

        <section id="letter" className="rw-letter-sec" aria-labelledby="rw-letter-h">
          <div className="wrap h-stage-wrap">
            <div className="h-sticker rw-sticker" aria-hidden="true">
              <span className="h-sticker-bubble">Send me the letter. I&rsquo;ll find the date.</span>
              <Mascot tile wave tone="orange" size={64} />
            </div>
            <h2 id="rw-letter-h" className="rw-h3">Mano quotes your letter and asks before it holds a date.</h2>
            <LetterDemo />
          </div>
        </section>
      </div>

      <section className="rw-moments" aria-labelledby="rw-moments-h">
        <div className="wrap">
          <div className="h-head">
            <h2 id="rw-moments-h">Renewals don&rsquo;t fail at the big moment. They fail at the small ones.</h2>
            <p className="lede">Here is what Mano does at each one today.</p>
          </div>
          <ol className="rw-cards">
            {MOMENTS.map((m, n) => (
              <li key={m.title} style={{ background: m.tint }}>
                <span className="rw-n">{n + 1}</span>
                <NeedIcon k={m.icon} size={48} />
                <b>{m.title}</b>
                <span>{m.text}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="rw-changed" aria-labelledby="rw-changed-h">
        <div className="wrap rw-split">
          <div>
            <h2 id="rw-changed-h">Something changed? Tell Mano once.</h2>
            <p className="lede">Say it in your own words. Mano updates the answers on your renewal and shows you the new numbers before anything goes out.</p>
          </div>
          <InView className="rw-changed-stage" threshold={0.35}>
            <p className="bub me rv" style={d(0.1)}>I work 24 hours a week now, not 20.</p>
            <div className="bub-row rv" style={d(0.9)}>
              <Mascot tile tone="orange" size={30} className="bub-av" />
              <p className="bub mano">got it. i updated your renewal. send me your newest pay stub and i&rsquo;ll check the income before you say yes.</p>
            </div>
            <div className="sc-card rw-diff rv" style={d(1.7)}>
              <div className="sc-card-head"><span>Food benefits renewal</span><span className="sc-label">Example</span></div>
              <dl>
                <div><dt>Hours a week</dt><dd><s>20</s> 24</dd></div>
                <div><dt>Monthly income</dt><dd><s>$2,140</s> $2,570</dd></div>
              </dl>
              <p className="sc-foot">Two answers changed. Mano asks for your yes on the new copy.</p>
            </div>
          </InView>
        </div>
      </section>

      <section className="rw-approve" aria-labelledby="rw-approve-h">
        <div className="wrap">
          <div className="rw-split">
            <div>
              <h2 id="rw-approve-h">Nothing goes out until you say yes.</h2>
              <p className="lede">Before your renewal goes to the office, Mano shows you who it is for, what it is for and every page. Tap the buttons to try it.</p>
            </div>
            <div className="rw-approve-stage">
              <ApprovalCard />
            </div>
          </div>
          <ul className="rw-promises">
            {PROMISES.map(([b, t]) => <li key={b}><b>{b}</b><span>{t}</span></li>)}
          </ul>
        </div>
      </section>

      <section className="rw-scam" aria-labelledby="rw-scam-h">
        <div className="wrap rw-split">
          <div>
            <h2 id="rw-scam-h">A text says your benefits will stop. Mano checks it first.</h2>
            <p className="lede">Scammers send fake renewal texts too. Forward one to Mano. It checks the link before anyone opens it, and it never follows a link that fails.</p>
          </div>
          <InView className="rw-scam-stage" threshold={0.35}>
            <p className="sc-label">Forwarded to Mano</p>
            <div className="rw-fwd rv" style={d(0.1)}>
              <span className="rw-from">From (555) 010-0199</span>
              <p>Verify your benefits now or they will stop today. Enter your Social Security number at benefits-verify-now.example</p>
            </div>
            <p className="bub me rv" style={d(0.7)}>is this real?</p>
            <div className="bub-row rv" style={d(1.4)}>
              <Mascot tile tone="orange" size={30} className="bub-av" />
              <p className="bub mano">don&rsquo;t open it. the link failed the safety check, and it asks for your Social Security number. your real renewal is due Dec 5, and i&rsquo;m still holding that date.</p>
            </div>
            <ol className="tr-steps rv" style={d(2.1)}>
              <li><span>Link</span>benefits-verify-now.example</li>
              <li className="warn"><span>Check</span>Failed the link safety check</li>
              <li className="ok"><span>Result</span>Not opened. Nothing sent.</li>
            </ol>
            <p className="rw-example">Example. The text and the link are made up.</p>
          </InView>
        </div>
      </section>

      <section className="rw-price" aria-labelledby="rw-price-h">
        <div className="wrap">
          <div className="rw-price-card">
            <Mascot tile wave tone="orange" size={64} className="rw-price-mascot" />
            <div>
              <h2 id="rw-price-h">Keeping your help is free. Always.</h2>
              <p className="lede">Reading your letters, holding dates, reminders and renewals are free, with no limits and no card.</p>
            </div>
            <Link className="btn btn-ghost btn-lg" href="/#pricing">See Free and Plus</Link>
          </div>
        </div>
      </section>

      <Faq items={faqs} />

      <section id="get-mano" className="h-close" aria-labelledby="close-h">
        <div className="wrap">
          <Mascot tile wave tone="orange" size={88} className="close-mascot" />
          <h2 id="close-h">Don&rsquo;t let one letter end your help.</h2>
          <p className="lede">Text Mano a photo of your renewal letter. It will find the date and start on it tonight.</p>
          <a className="close-num" href={SMS_HREF}>{SMS_NUMBER}</a>
          <div className="btn-row">
            <a className="btn btn-primary btn-lg" href={SMS_HREF}>Text Mano</a>
          </div>
          {SMS_IS_PLACEHOLDER ? <p className="note">{PLACEHOLDER_NOTE}</p> : <TextQr />}
        </div>
      </section>
    </div>
  );
}
