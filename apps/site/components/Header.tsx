"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import Mascot from "./Mascot";
import { SMS_HREF } from "@/lib/site";

const links = [
  { href: "/", label: "For you", sub: "Residents" },
  { href: "/government", label: "Government", sub: "Agencies and offices" },
  { href: "/organizations", label: "Nonprofits", sub: "Case managers" },
];

export default function Header() {
  const path = usePathname();
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => { if (menu.current) menu.current.open = false; }, [path]);

  return (
    <header className="site-header">
      <div className="wrap bar">
        <Link href="/" className="brand" aria-label="Mano home">
          <Mascot size={30} tile tone="orange" /> Mano
        </Link>
        <nav aria-label="Main" className="mainnav">
          {links.map((l) => (
            <Link key={l.href} href={l.href} aria-current={path === l.href ? "page" : undefined}>{l.label}</Link>
          ))}
        </nav>
        <div className="header-cta">
          <a className="btn btn-primary btn-sm" href={SMS_HREF}>Text Mano</a>
          <details className="menu" ref={menu}>
            <summary aria-label="Menu"><span /></summary>
            <nav aria-label="Main" className="menu-panel">
              {links.map((l) => (
                <Link key={l.href} href={l.href} aria-current={path === l.href ? "page" : undefined}>
                  {l.label} <small>{l.sub}</small>
                </Link>
              ))}
              <a className="btn btn-primary" href={SMS_HREF} style={{ width: "100%", marginTop: 6 }}>Text Mano</a>
            </nav>
          </details>
        </div>
      </div>
    </header>
  );
}
