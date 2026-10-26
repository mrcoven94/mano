import Glyph, { type GlyphName } from "./Glyph";

/* The hero's availability row. Apps are not in stores yet, so the row links to sign-up, never to a store. */
export default function Channels() {
  return (
    <a className="channels" href="#get-mano" aria-label="Mano works on iMessage, text, iPhone, Android, Mac, Windows and the web. Apps are in early access.">
      <span className="channels-tag">Early access</span>
      <span className="channel-glyphs" aria-hidden="true">{["imessage", "phone", "laptop", "web"].map((g) => <Glyph key={g} name={g as GlyphName} size={15} />)}</span>
      <span className="channel">Text, iMessage, apps and web</span>
    </a>
  );
}
