import type { Metadata } from "next";
import Faq from "@/components/Faq";
import ShareStage from "@/components/teams/ShareStage";
import { TeamHero, Today, Rules, Close } from "@/components/teams/Parts";
import { REPO_URL } from "@/lib/site";

const title = "Mano for nonprofits";
const description = "Mano has no product for nonprofit teams yet, and no nonprofit uses it. The case sharing it would rest on runs today on synthetic cases with one test office. The code and the protocol are open source.";

export const metadata: Metadata = { title, description, alternates: { canonical: "/organizations" }, openGraph: { title, description } };

const faqs: [string, string][] = [
  ["Does any nonprofit use Mano?", "No. No nonprofit uses Mano. Every case so far is synthetic, and the only office a person can share with is our own test office."],
  ["Can our team try it?", "Not yet. There is no way for a real team to get access. The code is MIT licensed, so you can read it and run your own copy."],
  ["How does a person share a case?", "They ask Mano by text. Mano names the office, the purpose and what goes, and nothing moves until they answer yes. They can stop by text too."],
  ["What happens to what was already shared?", "Stopping ends future access. Mano says plainly that it cannot pull back copies the office already has."],
  ["Who decides if someone gets help?", "The office that runs the program. Mano never decides if someone qualifies."],
];

export default function Organizations() {
  return (
    <div className="team">
      <TeamHero
        before="People choose "
        phrase="what you see"
        after="."
        lede="Mano has no product for nonprofit teams yet, and no nonprofit uses it. The sharing it would rest on runs today on synthetic cases with one test office: a person says yes by text, staff see only what was shared, and the person can stop."
        stage={<ShareStage />}
      >
        <a className="btn btn-primary btn-lg" href={REPO_URL}>Read the code</a>
        <a className="btn btn-ghost btn-lg" href="#org-today">What works today</a>
      </TeamHero>

      <Today
        id="org-today"
        title="What works today"
        today={[
          ["check", "Case sharing", "The code to share one case for one purpose, and to stop sharing, is written and runs. It has run only with a synthetic person and our test office."],
          ["clipboard", "The staff case screen", "On our sandbox portal, staff see what was shared, read live on every view, and can ask the person for a document. Mano checks with the person before anything goes."],
          ["code", "The open protocol", "The format agents use to work a shared case is public, with a written spec and a JSON Schema in the repository."],
          ["laptop", "Run your own copy", "Mano is MIT licensed. pnpm judge runs the renewal on your machine with no key, login or account."],
        ]}
        planned={[
          "Access for a real team. Today only the test office can be chosen.",
          "A web screen where case managers work the cases shared with them.",
          "One program built from one real policy document and reviewed by a person.",
        ]}
      />

      <Rules
        id="org-rules"
        title="What sharing means in the code"
        lede="These hold for every share today, and you can read how."
        facts={[
          ["One case, one purpose.", "A share names both, and the office sees nothing else."],
          ["Nothing moves without a yes.", "The person answers YES or NO to the exact version."],
          ["A person can stop.", "The case is gone from the staff screen at the next click."],
          ["Mano never sells personal data.", ""],
        ]}
      />

      <Faq id="org-questions" items={faqs} />

      <Close id="org-cta" title="Read how it works." text="The code, the protocol and the rules are public. Questions go to hello@withmano.com." />
    </div>
  );
}
