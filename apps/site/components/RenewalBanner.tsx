"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import Mascot from "./Mascot";
import { BANNER_ATTR, BANNER_KEY } from "@/lib/site";

/* A slim bar above the header that points people with a renewal letter to /renewals. Dismissing it sets an attribute on
   <html> and remembers it; the script in the root layout sets the same attribute before first paint, so a dismissed bar
   never flashes in and never moves the page. */

export default function RenewalBanner() {
  if (usePathname() === "/renewals") return null;

  const dismiss = () => {
    document.documentElement.setAttribute(BANNER_ATTR, "");
    try { localStorage.setItem(BANNER_KEY, "off"); } catch {}
  };

  return (
    <div className="rb" role="region" aria-label="Renewals">
      <p className="rb-text">
        <Mascot tile tone="orange" size={20} className="rb-mark" />
        <span><mark>Renewal letter?</mark> Text Mano a photo.</span>
        <Link href="/renewals" className="rb-link">See how</Link>
      </p>
      <button className="rb-x" onClick={dismiss} aria-label="Dismiss">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
      </button>
    </div>
  );
}
