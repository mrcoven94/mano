export default function Mascot({ size = 72, wave = true }: { size?: number; wave?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" role="img" aria-label="Mano, an open helping hand" className={wave ? "floaty" : undefined}>
      <path d="M38 58 C36 40 37 26 42 24 C47 22 49 30 49.5 40 L50 30 C50.5 20 53 14 57.5 14.5 C62 15 63 23 63.2 33 L64 24 C65 16 68.5 11 72.5 12.5 C76.5 14 76.8 22 76.4 31 L78 40 C79.5 32 83 27 86.5 29 C90.5 31 89.5 40 87 52 C91 46 95.5 43 98 46 C101 49.5 96 58 89 68 C82 82 71 90 57 89 C43 88 33 77 31.5 64 C31 60 34 52 38 58 Z"
        fill="#f4f4f2" stroke="#141414" strokeWidth="2.5" strokeLinejoin="round" />
      <circle cx="55" cy="62" r="3.2" fill="#141414" />
      <circle cx="71" cy="62" r="3.2" fill="#141414" />
      <path d="M56 71 C60 75 66 75 70 71" fill="none" stroke="#141414" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="47" cy="69" r="4" fill="#ffb26b" opacity=".8" />
      <circle cx="79" cy="69" r="4" fill="#ffb26b" opacity=".8" />
      <path d="M22 30 C18 36 17 42 18 48" fill="none" stroke="#67e8f9" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M14 24 C9 32 8 40 10 48" fill="none" stroke="#67e8f9" strokeWidth="2.5" strokeLinecap="round" opacity=".55" />
    </svg>
  );
}
