"use client";
import { useEffect, useRef } from "react";
import { useInView } from "@/components/InView";

/* Plays the first step of a demo on its own once it is on screen, unless the visitor has already
   clicked something or asked for reduced motion. Returns the ref to attach and a touch() to call on clicks. */
export function useAutoplay<T extends Element>(steps: [ms: number, run: () => void][]) {
  const [ref, seen] = useInView<T>(0.4);
  const touched = useRef(false);
  const plan = useRef(steps);

  useEffect(() => {
    if (!seen || touched.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ids = plan.current.map(([ms, run]) => setTimeout(() => { if (!touched.current) run(); }, ms));
    return () => ids.forEach(clearTimeout);
  }, [seen]);

  return [ref, () => { touched.current = true; }] as const;
}
