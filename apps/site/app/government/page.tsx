import type { Metadata } from "next";
import Faq from "@/components/Faq";
import Closing from "@/components/Closing";
import GovDemos from "@/components/GovDemos";
import { PageHero, Steps, Commitments, SeatStrip } from "@/components/PageParts";

const title = "Mano for government offices";
const description = "Cases arrive ready for a decision. Mano prepares each case with every finding cited to the rule, staff approve, and the agent types the case into the system you already run.";

export const metadata: Metadata = { title, description, alternates: { canonical: "/government" }, openGraph: { title, description } };

const MAIL = "mailto:agencies@withmano.com?subject=Claiming%20our%20office%20on%20Mano";

const faqs: [string, string][] = [
  ["Do we have to replace our current system?", "No. Your agent types approved cases into the system you already run. The old system stays and the retyping goes away."],
  ["Who decides a case?", "Your staff. Mano prepares the case, cites the rule behind each finding and flags what is missing. A person approves, denies or asks for more."],
  ["What can a resident see about our office?", "Your profile, and the cases they chose to share with you. A resident shares a case for one purpose and can take that access back."],
  ["Do agents call residents or other offices?", "Only when staff approve it. Every call starts by saying whose automated assistant is calling and that the call is transcribed."],
  ["How is it priced?", "Per staff seat. Residents never pay to apply, renew or file."],
  ["Is Mano a government system?", "No. Mano is independent. Your office keeps its own systems, seals and authority, and Mano never presents itself as your office."],
];

export default function Government() {
  return (
    <>
      <PageHero
        pill="For government offices"
        title="Cases arrive ready for a decision."
        lede="Mano prepares each case from your policy, with every finding cited to the rule. Your staff approve. Approved cases are typed into the system you already run."
        art="/art/office.svg"
        artAlt="Mano standing beside a small civic building, holding a folder with a check mark"
      >
        <a className="btn btn-primary btn-lg" href={MAIL}>Talk to us</a>
        <a className="btn btn-ghost btn-lg" href="#gov-work-h">See it work</a>
      </PageHero>

      <section aria-labelledby="gov-work-h" className="tint">
        <div className="wrap">
          <h2 id="gov-work-h" className="biz-h2">From policy to approved case.</h2>
          <GovDemos />
        </div>
      </section>

      <Steps
        id="gov-start"
        title="How an office starts."
        items={[
          ["Claim your profile", "Your office already has a public profile with its programs, hours and the documents it asks for. Claim it and it becomes your agent."],
          ["Give Mano one policy", "Mano drafts the questions, the evidence list and the notices. Your staff review it before it serves anyone."],
          ["Cases start arriving", "Complete, cited and ready for a decision. Approved cases are typed into your system."],
        ]}
      />

      <Commitments
        id="gov-rules"
        title="Your staff keep every decision."
        items={[
          "A person approves every case and every notice.",
          "Every finding cites the rule it rests on.",
          "Agents say they are automated on every call.",
          "Your systems, seal and authority stay yours.",
        ]}
      />

      <SeatStrip title="Priced per staff seat." text="Residents never pay to apply, renew or file." href={MAIL} />

      <Faq id="gov-questions" intro="For program directors, eligibility staff and IT." items={faqs} />

      <Closing id="gov-cta" title="Claim your office on Mano." text="Tell us about your office and the programs you run. We will set up the profile and your first program with you.">
        <a className="btn btn-primary" href={MAIL}>Talk to us</a>
        <a className="btn btn-ghost" href="/">See it from the family side</a>
      </Closing>
    </>
  );
}
