"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { REPO_URL } from "@/lib/site";
import Mascot from "./Mascot";
import TextMano from "./TextMano";

const links = [
  { href: "/how-it-works", label: "How Mano works", sub: "From a photo to a filing" },
  { href: "/renewals", label: "Renewals", sub: "Your letter came" },
  { href: "/government", label: "Government", sub: "What works today" },
  { href: "/partners", label: "Partners", sub: "What is planned" },
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
          <a className="quiet repo" href={REPO_URL}>Open source</a>
          <TextMano className="btn btn-primary btn-sm" align="end" />
          <details className="menu" ref={menu}>
            <summary aria-label="Menu"><span /></summary>
            <nav aria-label="Main" className="menu-panel">
              {links.map((l) => (
                <Link key={l.href} href={l.href} aria-current={path === l.href ? "page" : undefined}>
                  {l.label} <small>{l.sub}</small>
                </Link>
              ))}
              <a href={REPO_URL}>Open source <small>GitHub</small></a>
              <TextMano align="end" />
            </nav>
          </details>
        </div>
      </div>
    </header>
  );
}
