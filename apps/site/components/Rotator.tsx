"use client";
import { useEffect, useState } from "react";

export default function Rotator({ items }: { items: { text: string; color: string }[] }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setI((v) => (v + 1) % items.length), 2600);
    return () => clearInterval(t);
  }, [items.length]);
  const item = items[i];
  return (
    <span className="rotator" aria-hidden="true">
      <span key={i} className={i === 0 ? undefined : "in"} style={{ color: item.color }}>{item.text}</span>
    </span>
  );
}
