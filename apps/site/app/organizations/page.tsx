import type { Metadata } from "next";
import Faq from "@/components/Faq";
import Closing from "@/components/Closing";
import OrgDemos from "@/components/OrgDemos";
import { PageHero, Steps, Commitments, SeatStrip } from "@/components/PageParts";

const title = "Mano for nonprofits and case managers";
const description = "Every case manager gets an agent that knows their caseload, drafts the paperwork and chases documents. Launch a cash assistance program families apply to by text.";

export const metadata: Metadata = { title, description, alternates: { canonical: "/organizations" }, openGraph: { title, description } };

const MAIL = "mailto:organizations@withmano.com?subject=Mano%20for%20our%20team";

const faqs: [string, string][] = [
  ["What does a case manager do in Mano?", "Review and approve. The agent prepares applications, renewals and document requests from the caseload. The manager checks the exact draft and handles the conversations only a person can."],
  ["Can we run our own assistance program?", "Yes. You set the rules and the budget. Mano turns them into an application families complete by text, and prepares each case for your review."],
  ["How do families share cases with us?", "A family shares a case with your organization for one purpose. Your agent sees only that case, and the family can take the share back at any time."],
  ["How is it priced?", "Per seat, one for each case manager. Families never pay to apply, renew or file."],
  ["Does Mano replace case managers?", "No. Mano does the paperwork around the work. Case managers keep the relationships, the judgment calls and every approval."],
];

export default function Organizations() {
  return (
    <>
      <PageHero
        pill="For nonprofits and case managers"
        title="Drafts ready for review each morning."
        lede="Mano drafts renewals and applications from the case file, asks families for missing pages and holds every draft until your team approves it."
        art="/art/casework.svg"
        artAlt="Mano and a case manager looking at a document together"
      >
        <a className="btn btn-primary btn-lg" href={MAIL}>Talk to us</a>
        <a className="btn btn-ghost btn-lg" href="#org-work-h">See it work</a>
      </PageHero>

      <section aria-labelledby="org-work-h" className="tint">
        <div className="wrap">
          <h2 id="org-work-h" className="biz-h2">The paperwork, done before you get to it.</h2>
          <OrgDemos />
        </div>
      </section>

      <Steps
        id="org-start"
        title="How a team starts."
        items={[
          ["Bring your caseload", "Each case manager gets an agent with their cases, deadlines and program rules."],
          ["The agent drafts and chases", "Renewals and applications drafted from the case file. Missing documents requested from the family's Mano."],
          ["You approve and launch", "Your team approves every send. When you are ready, launch your own program in an afternoon."],
        ]}
      />

      <Commitments
        id="org-rules"
        title="Your team keeps every judgment call."
        items={[
          "Case managers approve every send and submission.",
          "Families share one case, for one purpose, and can take it back.",
          "The agent never contacts a family without your say.",
          "Mano never sells personal data.",
        ]}
      />

      <SeatStrip title="Priced per seat." text="One seat for each case manager. Families never pay to apply, renew or file." href={MAIL} />

      <Faq id="org-questions" intro="For program leads and case managers." items={faqs} />

      <Closing id="org-cta" title="Give your case managers their week back." text="Tell us about your team and your programs. We will set up your caseload agents with you.">
        <a className="btn btn-primary" href={MAIL}>Talk to us</a>
        <a className="btn btn-ghost" href="/">See it from the family side</a>
      </Closing>
    </>
  );
}
