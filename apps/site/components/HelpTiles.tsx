import Glyph, { type GlyphName } from "./Glyph";

/* The kinds of help Mano chases, floating around the hero art. Decorative; the lede says it in words. */
const tiles: { glyph: GlyphName; label: string; bg: string; x: string; y: string; r: number; d: number }[] = [
  { glyph: "food", label: "Food", bg: "var(--sage)", x: "6%", y: "8%", r: -8, d: 0 },
  { glyph: "home", label: "Rent", bg: "var(--peach)", x: "-2%", y: "44%", r: -4, d: 1.4 },
  { glyph: "stroller", label: "Child care", bg: "var(--lilac)", x: "8%", y: "82%", r: 6, d: 0.7 },
  { glyph: "heart", label: "Health", bg: "#F7B3C2", x: "92%", y: "6%", r: 7, d: 0.4 },
  { glyph: "gauge", label: "Credit", bg: "var(--butter)", x: "102%", y: "42%", r: 4, d: 1.1 },
  { glyph: "cap", label: "School", bg: "var(--sky)", x: "90%", y: "80%", r: -6, d: 1.8 },
  { glyph: "bus", label: "Rides", bg: "#B9E3D8", x: "34%", y: "-3%", r: 5, d: 2.2 },
  { glyph: "bolt", label: "Power bill", bg: "#FFD9A8", x: "70%", y: "96%", r: -5, d: 2.6 },
];

export default function HelpTiles() {
  return (
    <div className="help-tiles" aria-hidden="true">
      {tiles.map((t) => (
        <span key={t.label} className="help-tile" style={{ left: t.x, top: t.y, "--r": `${t.r}deg`, "--d": `${t.d}s` } as React.CSSProperties}>
          <span className="ht-box" style={{ background: t.bg }}><Glyph name={t.glyph} size={26} /></span>
          <span className="ht-label">{t.label}</span>
        </span>
      ))}
    </div>
  );
}
