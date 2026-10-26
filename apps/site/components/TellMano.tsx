import Glyph, { type GlyphName } from "./Glyph";
import { PARTNER_CREDIT, PARTNER_EBT, withPartner } from "@/lib/partners";

const asks: { glyph: GlyphName; bg: string; ask: string; does: string }[] = [
  { glyph: "gauge", bg: "var(--butter)", ask: "Help me raise my credit score.", does: `Mano reports the rent you already pay so it builds your credit${withPartner(PARTNER_CREDIT)}. It checks your report for mistakes too.` },
  { glyph: "food", bg: "var(--sage)", ask: "Handle my EBT.", does: `Mano renews your food benefits on time and tells you when money lands${withPartner(PARTNER_EBT)}.` },
  { glyph: "stroller", bg: "var(--lilac)", ask: "Find child care I can afford.", does: "Mano finds open spots near you and applies for help paying for them." },
  { glyph: "home", bg: "var(--peach)", ask: "I'm behind on rent.", does: "Mano applies for rent help. It checks for help with power and water bills too." },
  { glyph: "wifi", bg: "var(--sky)", ask: "Lower my phone and internet bill.", does: "Mano finds the discounts your family can get and signs you up." },
  { glyph: "cap", bg: "#B9E3D8", ask: "Find scholarships for my daughter.", does: "Mano finds scholarships that fit her and tracks every deadline." },
  { glyph: "heart", bg: "#F7B3C2", ask: "Renew my health coverage.", does: "Mano fills out the renewal from last year and asks you only what changed." },
  { glyph: "briefcase", bg: "#FFD9A8", ask: "Find job training that pays.", does: "Mano finds paid programs near you. It gets help with child care and rides too." },
  { glyph: "text", bg: "var(--bg3)", ask: "Wait on hold with unemployment for me.", does: "Mano calls, waits and texts you when a person picks up." },
];

export default function TellMano() {
  return (
    <ul className="asks" role="list">
      {asks.map((a) => (
        <li key={a.ask} className="ask-card">
          <span className="ask-icon" style={{ background: a.bg }}><Glyph name={a.glyph} size={22} /></span>
          <p className="ask-text">{a.ask}</p>
          <p className="ask-does">{a.does}</p>
        </li>
      ))}
    </ul>
  );
}
