import Link from "next/link";
import Mascot from "./Mascot";

export default function Footer() {
  return (
    <footer style={{ borderTop: "1px solid var(--border)", padding: "56px 0 40px", marginTop: 0 }}>
      <div className="wrap">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 32, flexWrap: "wrap" }}>
          <div style={{ maxWidth: 340 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 700, fontSize: "1.1rem" }}><Mascot size={32} wave={false} /> Mano</div>
            <p style={{ marginTop: 14, fontSize: ".92rem" }}>Apply once, for anything that makes your life better.</p>
          </div>
          <nav aria-label="Footer" style={{ display: "flex", gap: 56, flexWrap: "wrap" }}>
            <div>
              <p className="mono" style={{ marginBottom: 12 }}>Product</p>
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8, fontSize: ".92rem" }}>
                <li><Link href="/" style={{ color: "var(--muted)", textDecoration: "none" }}>For you</Link></li>
                <li><Link href="/government" style={{ color: "var(--muted)", textDecoration: "none" }}>Government</Link></li>
                <li><Link href="/organizations" style={{ color: "var(--muted)", textDecoration: "none" }}>Organizations</Link></li>
                <li><Link href="/#pricing" style={{ color: "var(--muted)", textDecoration: "none" }}>Pricing</Link></li>
              </ul>
            </div>
            <div>
              <p className="mono" style={{ marginBottom: 12 }}>Trust</p>
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8, fontSize: ".92rem", color: "var(--muted)" }}>
                <li>You approve every step</li>
                <li>You choose who sees your case</li>
                <li>Take access back any time</li>
              </ul>
            </div>
          </nav>
        </div>
        <p style={{ marginTop: 44, paddingTop: 22, borderTop: "1px solid var(--border)", fontSize: ".85rem", color: "var(--faint)", maxWidth: 760 }}>
          Mano is an independent service. Mano is not a government agency and is not affiliated with any government office. Program decisions are made by the agency that runs each program.
        </p>
        <p style={{ marginTop: 10, fontSize: ".85rem", color: "var(--faint)" }}>© 2026 Mano. Made with synthetic people in every example on this site. No real resident data is shown.</p>
      </div>
    </footer>
  );
}
