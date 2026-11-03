"use client";
import { useEffect, useId, useRef, useState } from "react";
import QRCode from "react-qr-code";
import { PLACEHOLDER_NOTE, SMS_HREF, SMS_IS_PLACEHOLDER, SMS_NUMBER } from "@/lib/site";

/* The Text Mano button, labeled with the number. It renders as an sms: link, which opens Messages with the number and a
   first line filled in on a phone and still works with no script. On a computer with a mouse, where an sms: link goes
   nowhere useful, it becomes a button that opens a small panel with a QR code to scan and the number to type. Escape,
   a click outside or the button again closes it. Until the real number is configured, a note under it says so. */
export default function TextMano({
  href = SMS_HREF,
  label = `Text Mano at ${SMS_NUMBER}`,
  className = "btn btn-primary",
  align = "center",
}: {
  href?: string;
  label?: string;
  className?: string;
  align?: "start" | "center" | "end";
}) {
  const [desktop, setDesktop] = useState(false);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    const mq = window.matchMedia("(hover: hover) and (pointer: fine)");
    const sync = () => { setDesktop(mq.matches); if (!mq.matches) setOpen(false); };
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const note = SMS_IS_PLACEHOLDER && <small className="text-mano-note">{PLACEHOLDER_NOTE}</small>;

  if (!desktop) return <span className="text-mano"><a className={className} href={href}>{label}</a>{note}</span>;

  return (
    <span className="text-mano" ref={wrap}>
      <button ref={button} type="button" className={className} aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        {label}
      </button>
      <span id={id} className="tm-pop" data-align={align} hidden={!open}>
        <span className="tm-qr"><QRCode value={href} size={136} aria-label="QR code that opens a text to Mano" /></span>
        <span className="tm-copy">
          <b>Scan with your phone camera</b>
          or text Mano at
          <a className="tm-num" href={href}>{SMS_NUMBER}</a>
        </span>
      </span>
      {note}
    </span>
  );
}
