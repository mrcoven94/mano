import type { Metadata } from "next";
import Faq from "@/components/Faq";
import OrgConsent from "@/components/teams/OrgConsent";
import OrgScenes from "@/components/teams/OrgScenes";
import Verified from "@/components/teams/Verified";
import { TeamHero, Stage, Steps, Rules, Seat, Close } from "@/components/teams/Parts";

const title = "Case management for nonprofits";
const description = "Give every case manager their own Mano. It gathers documents, fills out rent, food and child care applications and tracks every renewal, so families keep their help and your team spends its time with people.";

export const metadata: Metadata = { title, description, alternates: { canonical: "/organizations" }, openGraph: { title, description } };

const MAIL = "mailto:organizations@withmano.com?subject=Mano%20for%20our%20team";

const faqs: [string, string][] = [
  ["What can families get help with?", "Rent help, food benefits, light and water bills, health coverage and prescriptions, child care, housing waitlists and your own programs. Mano finds what each family qualifies for, applies and keeps every renewal on time."],
  ["What does a case manager do in Mano?", "Review and approve. The agent prepares applications, renewals and document requests from the caseload. The case manager checks the exact draft and handles the conversations only a person can."],
  ["How do families share cases with us?", "A family shares one case with your organization, for one purpose, until a date. Your agent sees only what was shared, and the family can stop sharing at any time."],
  ["Can we run our own assistance program?", "Yes. You set the rules and the budget. Mano drafts an application families complete by text, and prepares each case for your review."],
  ["How is it priced?", "Per seat, one for each case manager. Families never pay for help your team prepares for them."],
  ["Does Mano replace case managers?", "No. Mano does the paperwork around the work. Case managers keep the relationships, the judgment calls and every approval."],
];

const request = `{
  "type": "consent.request",
  "from": "org:northside-family-center",
  "asked_by": "staff:dana",
  "to": "person:maria-lopez",
  "purpose": "food-benefits-renewal",
  "documents": ["pay-stub-2026-10-24"],
  "until": "2026-12-31"
}`;

export default function Organizations() {
  return (
    <div className="team">
      <TeamHero
        eyebrow="For nonprofits and case managers"
        before="Keep more families "
        phrase="housed and fed"
        after="."
        lede="Give every case manager their own Mano. It gathers documents, fills out rent, food and child care applications and tracks every renewal, so your team spends its time with families instead of paperwork. Families choose what to share and can stop at any time."
        stage={<Stage id="desk" label="Northside Family Center" hint="Ask for the missing page, then answer as Maria"><OrgConsent /></Stage>}
      >
        <a className="btn btn-primary btn-lg" href={MAIL}>Talk to us</a>
        <a className="btn btn-ghost btn-lg" href="#org-start">How a team starts</a>
      </TeamHero>

      <section className="t-more" aria-labelledby="org-more-h">
        <div className="wrap">
          <div className="h-head">
            <p className="h-eyebrow">The rest of the week</p>
            <h2 id="org-more-h">The paperwork, done before you get to it.</h2>
          </div>
          <OrgScenes />
        </div>
      </section>

      <Verified id="org-vf" eyebrow="When a family shares a case" office="Northside Family Center" />

      <Rules
        id="org-rules"
        eyebrow="Your team keeps every judgment call"
        title="Families choose what you see."
        lede="Every request names who is asking, for what and until when. The family answers in their own Mano, and their answer is kept with the case."
        facts={[
          ["One case, one purpose, one date.", "Families share exactly that, and nothing else in their Mano."],
          ["Families can stop sharing.", "Mano tells them which copies you already have, because it cannot pull those back."],
          ["Case managers approve", "every send and every submission."],
          ["The agent never contacts a family", "without your say."],
          ["Mano never sells personal data.", ""],
        ]}
        file="consent-request.json"
        code={request}
      />

      <Steps
        id="org-start"
        eyebrow="How a team starts"
        title="Set up your team’s caseload."
        art="/art/casework.svg"
        artAlt="Mano and a case manager looking at a document together"
        items={[
          ["Bring your caseload", (
            <>
              <p className="sc-label">Northside Family Center</p>
              <p className="share-big">6 case managers, 412 families</p>
              <p className="share-small">Each case manager gets an agent with their cases, deadlines and your program rules.</p>
            </>
          )],
          ["Families connect", (
            <>
              <p className="sc-label">By text, in their own Mano</p>
              <p className="share-big">&ldquo;Share my renewal with Northside?&rdquo;</p>
              <p className="share-small">Each family chooses what to share with you. Families who don&rsquo;t use Mano are still on your caseload.</p>
            </>
          )],
          ["Approve and send", (
            <>
              <p className="sc-label">Every morning</p>
              <p className="share-big">Drafts waiting for your yes</p>
              <p className="share-small">Your team approves every send. When you are ready, launch your own program.</p>
            </>
          )],
        ]}
      />

      <Seat title="Priced per seat." text="One seat for each case manager. Families never pay for help your team prepares for them." href={MAIL} />

      <Faq id="org-questions" items={faqs} />

      <Close id="org-cta" title="Bring Mano to your team." text="Tell us about your team and your programs. We will set up Mano for your case managers with you." href={MAIL} />
    </div>
  );
}
