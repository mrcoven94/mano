import Link from "next/link";
import { REPO_URL, SMS_HREF, SMS_NUMBER } from "@/lib/site";
import Mascot from "./Mascot";

export default function Footer() {
  return (
    <footer className="site-footer">
      <div className="wrap">
        <div className="foot-card">
          <Mascot tile wave tone="orange" size={72} className="foot-mascot" />
          <div className="foot">
            <div>
              <Link href="/" className="brand"><Mascot size={30} tile tone="orange" className="brand-mark" />mano</Link>
              <p className="foot-about">An agent for every person. It applies for help, reads your mail and keeps your help coming.</p>
              <a className="foot-text" href={SMS_HREF}>Text Mano at {SMS_NUMBER}</a>
            </div>
            <nav aria-label="Footer">
              <p className="foot-h">Mano</p>
              <ul>
                <li><Link href="/">For people</Link></li>
                <li><Link href="/how-it-works">How Mano works</Link></li>
                <li><Link href="/#pricing">Pricing</Link></li>
                <li><Link href="/#questions">Questions</Link></li>
              </ul>
            </nav>
            <nav aria-label="Teams">
              <p className="foot-h">Teams</p>
              <ul>
                <li><Link href="/government">For government</Link></li>
                <li><Link href="/organizations">For nonprofits</Link></li>
                <li><Link href="/partners">Partners</Link></li>
              </ul>
            </nav>
            <nav aria-label="Open source">
              <p className="foot-h">Build</p>
              <ul>
                <li><a href={REPO_URL}>Source code</a></li>
                <li><Link href="/stats">Usage stats</Link></li>
                <li><a href={`${REPO_URL}/blob/main/LICENSE`}>MIT license</a></li>
                <li><a href="mailto:hello@withmano.com">hello@withmano.com</a></li>
              </ul>
            </nav>
          </div>
          <div className="legal">
            <p>Every person in the examples on this site is made up.</p>
          </div>
        </div>
      </div>
    </footer>
  );
}
