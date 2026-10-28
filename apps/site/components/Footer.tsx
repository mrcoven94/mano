import Link from "next/link";
import { REPO_URL } from "@/lib/site";
import Mascot from "./Mascot";

export default function Footer() {
  return (
    <footer className="site-footer">
      <div className="wrap">
        <div className="foot">
          <div>
            <Link href="/" className="brand"><Mascot size={30} tile tone="orange" className="brand-mark" />mano</Link>
            <p style={{ marginTop: 16, maxWidth: 320, fontSize: ".95rem" }}>An agent for every person. It applies for help, reads your mail and keeps your help coming.</p>
          </div>
          <nav aria-label="Footer">
            <p className="mono">Mano</p>
            <ul>
              <li><Link href="/">For people</Link></li>
              <li><Link href="/how-it-works">How Mano works</Link></li>
              <li><Link href="/#pricing">Pricing</Link></li>
              <li><Link href="/#questions">Questions</Link></li>
            </ul>
          </nav>
          <nav aria-label="Teams">
            <p className="mono">Teams</p>
            <ul>
              <li><Link href="/government">For offices</Link></li>
              <li><Link href="/organizations">For nonprofits</Link></li>
              <li><Link href="/partners">Partners</Link></li>
            </ul>
          </nav>
          <nav aria-label="Open source">
            <p className="mono">Build</p>
            <ul>
              <li><a href={REPO_URL}>Source code</a></li>
              <li><a href={`${REPO_URL}/blob/main/LICENSE`}>MIT license</a></li>
              <li><a href="mailto:hello@withmano.com">hello@withmano.com</a></li>
            </ul>
          </nav>
        </div>
        <div className="legal">
          <p>Mano is independent. It is not a government agency and is not part of any government office. The agency that runs a program makes every decision about it.</p>
          <p>Every person in the examples on this site is made up.</p>
        </div>
      </div>
    </footer>
  );
}
