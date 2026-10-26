"use client";
import { useEffect, useState } from "react";

/* Phone-only "Get Mano" bar that appears once the hero buttons scroll away and hides again at the sign-up section. */
export default function StickyCta() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const hero = document.getElementById("hero-cta");
    const end = document.getElementById("get-mano");
    if (!hero || !end) return;
    let heroGone = false, atEnd = false;
    const update = () => setShow(heroGone && !atEnd);
    const a = new IntersectionObserver(([e]) => { heroGone = !e.isIntersecting && e.boundingClientRect.top < 0; update(); });
    const b = new IntersectionObserver(([e]) => { atEnd = e.isIntersecting; update(); });
    a.observe(hero); b.observe(end);
    return () => { a.disconnect(); b.disconnect(); };
  }, []);
  return <a className={`btn btn-primary mobile-cta${show ? " is-on" : ""}`} href="#get-mano" aria-hidden={!show} tabIndex={show ? 0 : -1}>Get Mano free</a>;
}
