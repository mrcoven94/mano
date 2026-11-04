import Link from "next/link";
import Mascot from "@/components/Mascot";
import { REPO_URL } from "@/lib/site";

/* The short, true page for each kind of team: what does not exist, what does, and where to read the code. */
export default function Today({ title, lede, items }: { title: string; lede: string; items: [string, string][] }) {
  return (
    <div className="team">
      <div className="t-hero t-today">
        <div className="wrap">
          <Mascot tile wave tone="orange" size={72} />
          <h1>{title}</h1>
          <p className="h-lede">{lede}</p>
          <ul className="t-today-list">
            {items.map(([b, t]) => <li key={b}><b>{b}</b> {t}</li>)}
          </ul>
          <div className="btn-row h-ctas">
            <a className="btn btn-primary btn-lg" href={REPO_URL}>Read the code</a>
            <Link className="btn btn-ghost btn-lg" href="/how-it-works">How Mano works</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
