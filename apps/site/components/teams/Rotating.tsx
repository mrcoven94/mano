"use client";
import { useEffect, useState } from "react";

/* A highlighted phrase that changes every few seconds, redrawing the highlighter each time. Holds still for
   people who ask for less motion. */
export default function Rotating({ words, seconds = 2.6 }: { words: string[]; seconds?: number }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(() => setI((x) => (x + 1) % words.length), seconds * 1000);
    return () => clearInterval(id);
  }, [words.length, seconds]);
  return (
    <>
      <mark key={i} className="h-phrase" aria-hidden="true">{words[i]}</mark>
      <span className="sr-only">{words.join(", ")}</span>
    </>
  );
}
