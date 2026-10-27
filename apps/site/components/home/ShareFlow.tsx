import Link from "next/link";
import InView from "@/components/InView";
import Mascot from "@/components/Mascot";

/* Case management for nonprofits and offices, start to finish: a caseworker asks, the person shares, the case is ready. */

const d = (s: number) => ({ "--d": `${s}s` }) as React.CSSProperties;

export default function ShareFlow() {
  return (
    <div className="share">
      <div className="h-head">
        <h2 id="share-h">Case management made easy for nonprofits and government offices.</h2>
        <p className="lede">Give every caseworker their own Mano. It gathers documents, fills out applications and tracks every renewal for the people they serve, so staff spend their time with people instead of paperwork. Residents pick what to share and can stop sharing at any time.</p>
      </div>

      <InView as="ol" className="share-flow" threshold={0.3}>
        <li className="share-step rv" style={d(0.1)}>
          <p className="share-n"><span>01</span>Dana asks for a pay stub</p>
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
          <p className="share-n"><span>02</span>Maria taps Share</p>
          <div className="share-card">
            <p className="share-from"><Mascot tile tone="orange" size={26} />Mano, to Maria</p>
            <p className="share-msg">Dana is asking for your October 24 pay stub for your renewal. Share it with Northside until December 31?</p>
            <div className="share-btns"><span className="tr-yes">Share it</span><span className="tr-no">Not now</span></div>
          </div>
        </li>
        <li className="share-step rv" style={d(0.9)}>
          <p className="share-n"><span>03</span>The renewal is ready</p>
          <div className="share-card">
            <p className="sc-label">Northside case 0418</p>
            <p className="share-big">Renewal ready to submit</p>
            <p className="share-small">No phone tag and no missing pages. Maria can see who has her pay stub and stop sharing whenever she wants.</p>
          </div>
        </li>
      </InView>

      <div className="share-links">
        <Link href="/organizations">Case management for nonprofits</Link>
        <Link href="/government">Case management for government</Link>
        <Link href="/partners">Partners</Link>
      </div>
    </div>
  );
}
