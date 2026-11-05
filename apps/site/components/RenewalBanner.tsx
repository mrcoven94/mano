"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import Mascot from "./Mascot";
import { BANNER_ATTR, BANNER_KEY } from "@/lib/site";

/* A slim bar above the header that sends judges of the Meta AI Hackathon to /try, the one page with the live demo and
   the test results. It shows everywhere except /try itself. Dismissing it sets an attribute on
   <html> and remembers it; the script in the root layout sets the same attribute before first paint, so a dismissed bar
   never flashes in and never moves the page. */

export default function RenewalBanner() {
  const path = usePathname();
  if (path === "/try") return null;

  const dismiss = () => {
    document.documentElement.setAttribute(BANNER_ATTR, "");
    try { localStorage.setItem(BANNER_KEY, "off"); } catch {}
  };

  return (
    <div className="rb" role="region" aria-label="For judges">
      <p className="rb-text">
        <Mascot tile tone="orange" size={20} className="rb-mark" />
        <span><mark>For judges of the Meta AI Hackathon:</mark> run Mano live and see the test results, no login.</span>
        <Link href="/try" className="rb-link">Test it live</Link>
      </p>
      <button className="rb-x" onClick={dismiss} aria-label="Dismiss">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
      </button>
    </div>
  );
}
