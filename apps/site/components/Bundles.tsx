import Glyph, { type GlyphName } from "./Glyph";
import InView from "./InView";

/* One need leads to the next. Each bundle is a starting ask and the help that usually comes with it. */
const bundles: { start: string; glyph: GlyphName; bg: string; next: string[] }[] = [
  { start: "Food stamps for me and 4 kids", glyph: "food", bg: "var(--sage)", next: ["Child care help", "Free school meals", "WIC for kids under 5", "Bus pass discount"] },
  { start: "Help with rent", glyph: "home", bg: "var(--peach)", next: ["Power and water bill help", "Phone and internet discount", "Food help"] },
  { start: "I lost my job", glyph: "briefcase", bg: "#FFD9A8", next: ["Unemployment", "Health coverage", "Food help", "Paid job training"] },
  { start: "We had a baby", glyph: "stroller", bg: "var(--lilac)", next: ["WIC", "Health coverage for the baby", "Child care help", "Diapers and supplies"] },
];

export default function Bundles() {
  return (
    <div className="bundles">
      {bundles.map((b) => (
        <InView key={b.start} className="bundle">
          <div className="b-start">
            <span className="b-icon" style={{ background: b.bg }}><Glyph name={b.glyph} size={20} /></span>
            <span><small>You ask for</small><strong>{b.start}</strong></span>
          </div>
          <ul className="b-next" role="list">
            {b.next.map((n, k) => (
              <li key={n} style={{ "--k": k } as React.CSSProperties}><span className="b-check" aria-hidden="true" />{n}</li>
            ))}
          </ul>
          <p className="b-foot">Mano checks all {b.next.length} and asks before applying.</p>
        </InView>
      ))}
    </div>
  );
}
