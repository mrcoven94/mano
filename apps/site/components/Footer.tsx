import Link from "next/link";
import Mascot from "./Mascot";

export default function Footer() {
  return (
    <footer className="site-footer">
      <div className="wrap">
        <div className="foot">
          <div>
            <Link href="/" className="brand"><Mascot size={30} tile tone="orange" /> Mano</Link>
            <p style={{ marginTop: 16, maxWidth: 320, fontSize: ".95rem" }}>Help for your whole family, from getting by to getting ahead.</p>
          </div>
          <nav aria-label="Footer">
            <p className="mono">Mano</p>
            <ul>
              <li><Link href="/">For you</Link></li>
              <li><Link href="/#pricing">Pricing</Link></li>
              <li><Link href="/#questions">Questions</Link></li>
            </ul>
          </nav>
          <nav aria-label="Teams">
            <p className="mono">Teams</p>
            <ul>
              <li><Link href="/government">Government</Link></li>
              <li><Link href="/organizations">Nonprofits</Link></li>
              <li><Link href="/partners">Partners</Link></li>
              <li><a href="mailto:hello@withmano.com">hello@withmano.com</a></li>
            </ul>
          </nav>
          <div>
            <p className="mono">Your rules</p>
            <ul>
              <li>You approve every step</li>
              <li>You choose who sees your case</li>
              <li>You can take access back</li>
            </ul>
          </div>
        </div>
        <div className="legal">
          <p>Mano is independent. It is not a government agency and is not part of any government office. The agency that runs a program makes every decision about it.</p>
          <p>Every person in the examples on this site is made up.</p>
        </div>
      </div>
    </footer>
  );
}
