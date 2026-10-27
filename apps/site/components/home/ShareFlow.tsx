import Link from "next/link";
import InView from "@/components/InView";
import Mascot from "@/components/Mascot";

/* One shared case, start to finish: the caseworker's agent asks, the person decides, the document arrives. */

const d = (s: number) => ({ "--d": `${s}s` }) as React.CSSProperties;

export default function ShareFlow() {
  return (
    <div className="share">
      <div className="h-head">
        <h2 id="share-h">Share one case, for one reason, with the people helping you.</h2>
        <p className="lede">Nonprofits and offices can give their staff Mano too. When Dana at Northside needs a document for Maria&rsquo;s renewal, her agent asks Maria&rsquo;s agent. Nothing moves until Maria agrees.</p>
      </div>

      <InView as="ol" className="share-flow" threshold={0.3}>
        <li className="share-step rv" style={d(0.1)}>
          <p className="share-n"><span>01</span>Dana asks</p>
          <div className="share-card">
            <p className="sc-label">Request from Northside Family Center</p>
            <p className="share-big">Pay stub, October 24</p>
            <dl className="share-dl">
              <div><dt>For</dt><dd>Food benefits renewal</dd></div>
              <div><dt>Asked by</dt><dd>Dana, case manager</dd></div>
            </dl>
          </div>
        </li>
        <li className="share-step rv" style={d(0.5)}>
          <p className="share-n"><span>02</span>Maria decides</p>
          <div className="share-card">
            <p className="share-from"><Mascot tile tone="orange" size={26} />Mano, to Maria</p>
            <p className="share-msg">Dana is asking for your October 24 pay stub for your renewal. Share it with Northside until December 31?</p>
            <div className="share-btns"><span className="tr-yes">Share it</span><span className="tr-no">Not now</span></div>
          </div>
        </li>
        <li className="share-step rv" style={d(0.9)}>
          <p className="share-n"><span>03</span>Dana gets one page</p>
          <div className="share-card">
            <p className="sc-label">Northside case 0418</p>
            <p className="share-big">Renewal ready to submit</p>
            <p className="share-small">Maria can see who has access and take it back at any time. Mano tells her which copies were already sent.</p>
          </div>
        </li>
      </InView>

      <div className="share-links">
        <Link href="/organizations">Mano for nonprofits</Link>
        <Link href="/government">Mano for offices</Link>
        <Link href="/partners">Partners</Link>
      </div>
    </div>
  );
}
