"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import Mascot from "./Mascot";

const links = [
  { href: "/", label: "For you" },
  { href: "/government", label: "Government" },
  { href: "/organizations", label: "Organizations" },
];

export default function Header() {
  const path = usePathname();
  return (
    <header style={{ position: "sticky", top: 0, zIndex: 50, backdropFilter: "blur(14px)", background: "rgba(20,20,20,.82)", borderBottom: "1px solid var(--border)" }}>
      <div className="wrap headerbar" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", minHeight: 68, gap: 16 }}>
        <Link href="/" className="brand" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none", fontWeight: 700, fontSize: "1.15rem", letterSpacing: "-.02em", flex: "none" }} aria-label="Mano home">
          <Mascot size={34} wave={false} /> Mano
        </Link>
        <nav aria-label="Main" style={{ display: "flex", gap: 4, alignItems: "center" }}>
          {links.map((l) => (
            <Link key={l.href} href={l.href} className="navlink" aria-current={path === l.href ? "page" : undefined}
              style={{ padding: "8px 13px", borderRadius: 999, textDecoration: "none", fontSize: ".92rem", color: path === l.href ? "var(--text)" : "var(--muted)", background: path === l.href ? "var(--fill2)" : "transparent" }}>
              {l.label}
            </Link>
          ))}
          <Link href="/#get-started" className="btn btn-primary navcta" style={{ padding: "9px 16px", marginLeft: 8, fontSize: ".88rem" }}>Get started</Link>
        </nav>
      </div>
    </header>
  );
}
