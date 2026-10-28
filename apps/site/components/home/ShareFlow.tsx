import Link from "next/link";
import InView from "@/components/InView";
import Mascot from "@/components/Mascot";
import { NeedIcon } from "./NeedIcons";

/* Case management for nonprofits and offices, start to finish: a caseworker asks, the person shares, the case is ready. */

function Arrow() {
  return (
    <svg viewBox="0 0 60 40" width="60" height="40">
      <path d="M4 26C18 8 36 6 52 18" fill="none" stroke="#121212" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M44 12L53 19L43 24" fill="none" stroke="#121212" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

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
          <p className="share-n">Dana asks for a pay stub</p>
          <div className="share-card">
            <p className="share-from"><span className="share-av">D</span><span>Dana<small>Case manager, Northside Family Center</small></span></p>
            <p className="share-msg">Could you share your October 24 pay stub? It&rsquo;s the last page your food benefits renewal needs.</p>
            <div className="share-doc"><NeedIcon k="clipboard" size={34} /><span><b>Pay stub, Oct 24</b><small>For the food benefits renewal</small></span></div>
          </div>
        </li>
        <li className="share-arrow" aria-hidden="true"><Arrow /></li>
        <li className="share-step rv" style={d(0.5)}>
          <p className="share-n">Maria taps Share</p>
          <div className="share-card">
            <p className="share-from"><Mascot tile tone="orange" size={30} /><span>Mano<small>To Maria, by text</small></span></p>
            <p className="share-msg">Dana is asking for your October 24 pay stub for your renewal. Share it with Northside until December 31?</p>
            <div className="share-btns"><span className="share-yes">Share it</span><span className="share-no">Not now</span></div>
          </div>
        </li>
        <li className="share-arrow" aria-hidden="true"><Arrow /></li>
        <li className="share-step rv" style={d(0.9)}>
          <p className="share-n">The renewal is ready</p>
          <div className="share-card">
            <p className="share-from"><NeedIcon k="check" size={34} /><span>Northside case 0418<small>Food benefits renewal</small></span></p>
            <p className="share-big">Ready to submit</p>
            <p className="share-small"><mark>4 of 4 pages.</mark> No phone tag. Maria can see who has her pay stub and stop sharing whenever she wants.</p>
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
