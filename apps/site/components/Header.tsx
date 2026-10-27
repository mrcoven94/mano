"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { REPO_URL } from "@/lib/site";
import Mascot from "./Mascot";

const links = [
  { href: "/", label: "For people", sub: "Free for everyone" },
  { href: "/government", label: "For offices", sub: "Agencies" },
  { href: "/organizations", label: "For nonprofits", sub: "Case managers" },
  { href: "/partners", label: "Partners", sub: "Offer your service" },
  { href: "/#pricing", label: "Pricing", sub: "Free and Plus" },
];

export default function Header() {
  const path = usePathname();
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => { if (menu.current) menu.current.open = false; }, [path]);

  return (
    <header className="site-header">
      <div className="wrap bar">
        <Link href="/" className="brand" aria-label="Mano home"><Mascot size={30} tile tone="orange" className="brand-mark" />mano</Link>
        <nav aria-label="Main" className="mainnav">
          {links.map((l) => (
            <Link key={l.href} href={l.href} aria-current={path === l.href ? "page" : undefined}>{l.label}</Link>
          ))}
        </nav>
        <div className="header-cta">
          <a className="quiet" href={REPO_URL}>Open source</a>
          <a className="btn btn-primary btn-sm" href="/#get-mano">Text Mano</a>
          <details className="menu" ref={menu}>
            <summary aria-label="Menu"><span /></summary>
            <nav aria-label="Main" className="menu-panel">
              {links.map((l) => (
                <Link key={l.href} href={l.href} aria-current={path === l.href ? "page" : undefined}>
                  {l.label} <small>{l.sub}</small>
                </Link>
              ))}
              <a href={REPO_URL}>Open source <small>GitHub</small></a>
              <a className="btn btn-primary" href="/#get-mano" style={{ width: "100%", marginTop: 6 }}>Text Mano</a>
            </nav>
          </details>
        </div>
      </div>
    </header>
  );
}
