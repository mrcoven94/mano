"use client";
import { useEffect, useRef, useState } from "react";

/* Sets data-in on its element the first time it scrolls into view, so CSS can play an entrance once. */
export function useInView<T extends Element>(threshold = 0.25) {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setSeen(true); io.disconnect(); } }, { threshold });
    io.observe(el);
    return () => io.disconnect();
  }, [seen, threshold]);
  return [ref, seen] as const;
}

export default function InView({ as: Tag = "div", className, children, threshold }: { as?: "div" | "ul" | "ol"; className?: string; children: React.ReactNode; threshold?: number }) {
  const [ref, seen] = useInView<HTMLDivElement>(threshold);
  return <Tag ref={ref as never} className={className} data-in={seen || undefined}>{children}</Tag>;
}
