import type { Metadata } from "next";
import Faq from "@/components/Faq";
import GovDesk from "@/components/teams/GovDesk";
import GovScenes from "@/components/teams/GovScenes";
import { TeamHero, Stage, Steps, Rules, Seat, Close } from "@/components/teams/Parts";

const title = "Mano for government offices";
const description = "Cases arrive ready for a decision, with every finding cited to the rule. Your staff approve, and Mano enters the case into the system you already run.";

export const metadata: Metadata = { title, description, alternates: { canonical: "/government" }, openGraph: { title, description } };

const MAIL = "mailto:agencies@withmano.com?subject=Claiming%20our%20office%20on%20Mano";

const faqs: [string, string][] = [
  ["Do we have to replace our current system?", "No. Your agent types approved cases into the system you already run, the way a person would, and reads the screen back to check it. The old system stays and the retyping goes away."],
  ["Who decides a case?", "Your staff. Mano prepares the case, cites the rule behind each finding and flags what it cannot settle. A person approves, denies or asks for more."],
  ["What can a resident see about our office?", "Your profile, and the cases they chose to share with you. A resident shares a case for one purpose and can take that access back."],
  ["Do agents call residents or other offices?", "Only when staff approve it. Every call starts by saying whose automated assistant is calling and that the call is transcribed."],
  ["How is it priced?", "Per staff seat. Residents never pay to apply, renew or file."],
  ["Is Mano a government system?", "No. Mano is independent. Your office keeps its own systems, seals and authority, and Mano never presents itself as your office."],
];

const log = `{
  "action": "case_system.enter",
  "case": "sample-county/0418",
  "approved_by": "staff:j-park",
  "approval": {
    "recipient": "sample-county/case-system",
    "purpose": "food-benefits-renewal",
    "copy": "sha256:7f3ac19e…"
  },
  "idempotency_key": "0418-recert-2026-10",
  "logged_at": "2026-10-27T10:42:03Z",
  "result": "saved; screen read back; matches"
}`;

export default function Government() {
  return (
    <div className="team">
      <TeamHero
        eyebrow="For government offices"
        before="Cases arrive "
        phrase="ready"
        after=" for your staff to decide."
        lede="Mano prepares each case from your policy and cites the rule behind every finding. When a caseworker approves, Mano enters it into the system you already run, and you can watch every keystroke."
        stage={<Stage id="desk" label="Sample County Human Services" hint="Approve the case, or ask for more"><GovDesk /></Stage>}
      >
        <a className="btn btn-primary btn-lg" href={MAIL}>Talk to us</a>
        <a className="btn btn-ghost btn-lg" href="#gov-start">How an office starts</a>
      </TeamHero>

      <section className="t-more" aria-labelledby="gov-more-h">
        <div className="wrap">
          <div className="h-head">
            <p className="h-eyebrow">Before the case reaches you</p>
            <h2 id="gov-more-h">The busywork around each decision, done.</h2>
          </div>
          <GovScenes />
        </div>
      </section>

      <Rules
        id="gov-rules"
        eyebrow="Your staff keep every decision"
        title="Every action is written down before it happens."
        lede="After a caseworker approves, Mano records the approval, then enters the case. An approval covers one recipient, one purpose and one exact copy. If anything is unclear, it stops."
        facts={[
          ["A person approves", "every case and every notice."],
          ["Every finding cites", "the rule it rests on, with the evidence attached."],
          ["Nothing is entered twice.", "After a timeout, Mano checks whether the case was saved before it tries again."],
          ["Agents say they are automated", "on every call, and that the call is transcribed."],
          ["Your systems, seal and authority", "stay yours."],
        ]}
        file="action-log.json"
        code={log}
      />

      <Steps
        id="gov-start"
        eyebrow="How an office starts"
        title="Your office already has a profile. Claim it."
        art="/art/office.svg"
        artAlt="Mano standing beside a small civic building, holding a folder with a check mark"
        items={[
          ["Find your profile", (
            <>
              <p className="sc-label">Independent profile · Not claimed</p>
              <p className="share-big">Sample County Human Services</p>
              <p className="share-small">Programs, hours and the documents you ask for, written from public sources. It cannot message residents, request records or send notices.</p>
            </>
          )],
          ["Claim it", (
            <>
              <p className="sc-label">Claimed Oct 20</p>
              <p className="share-big">Office agent, 12 staff seats</p>
              <p className="share-small">Your profile becomes an agent. Each caseworker gets their own, with your policies and programs.</p>
            </>
          )],
          ["Give it one policy", (
            <>
              <p className="sc-label">Reviewed by staff</p>
              <p className="share-big">Food benefits renewal is live</p>
              <p className="share-small">Mano drafts the questions, proof list and notices. Your staff review them before they serve anyone.</p>
            </>
          )],
        ]}
      />

      <Seat title="Priced per staff seat." text="Residents never pay to apply, renew or file." href={MAIL} />

      <Faq id="gov-questions" items={faqs} />

      <Close id="gov-cta" title="Claim your office on Mano." text="Tell us about your office and the programs you run. We will set up your profile and your first program with you." href={MAIL} />
    </div>
  );
}
