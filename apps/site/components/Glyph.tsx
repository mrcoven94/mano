/* Small line glyphs for channels and kinds of help. Generic shapes, no third-party logos. */
const paths: Record<string, React.ReactNode> = {
  imessage: <path d="M12 4c4.97 0 9 3.36 9 7.5S16.97 19 12 19c-1.1 0-2.15-.16-3.12-.46L4.5 20l1.2-3.5C4.02 15.13 3 13.4 3 11.5 3 7.36 7.03 4 12 4Z" />,
  text: <><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 3v-3H6.5A2.5 2.5 0 0 1 4 14.5v-8Z" /><path d="M8.5 10.5h.01M12 10.5h.01M15.5 10.5h.01" strokeWidth="2.6" /></>,
  phone: <><rect x="6.5" y="3" width="11" height="18" rx="2.6" /><path d="M10.5 18h3" /></>,
  laptop: <><rect x="4.5" y="5" width="15" height="10.5" rx="1.6" /><path d="M2.5 19h19" /></>,
  window: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.2" /><path d="M3.5 9h17M12 9v10.5" /></>,
  food: <><path d="M4 10h16l-1.6 8.2a2 2 0 0 1-2 1.6H7.6a2 2 0 0 1-2-1.6L4 10Z" /><path d="M8.5 10 11 4.5M15.5 10 13 4.5M9 14v2.5M12 14v2.5M15 14v2.5" /></>,
  home: <><path d="M4 11 12 4.5 20 11" /><path d="M6 9.5V19h12V9.5" /><path d="M10 19v-5h4v5" /></>,
  stroller: <><path d="M5 5h1.5l2 8.5h9.5" /><path d="M8 13.5c0-4 3-7 7-7 2.2 0 3.5 1 3.5 1v6" /><circle cx="9" cy="18" r="1.8" /><circle cx="17" cy="18" r="1.8" /></>,
  heart: <><path d="M12 19.5s-7.5-4.6-7.5-9.7A4.1 4.1 0 0 1 12 7.4a4.1 4.1 0 0 1 7.5 2.4c0 5.1-7.5 9.7-7.5 9.7Z" /><path d="M12 10.5v4M10 12.5h4" /></>,
  gauge: <><path d="M4.5 16.5a7.5 7.5 0 1 1 15 0" /><path d="M12 16.5 15.5 11" /><path d="M7 16.5h.01M17 16.5h.01" strokeWidth="2.4" /></>,
  cap: <><path d="M2.5 9.5 12 5l9.5 4.5L12 14 2.5 9.5Z" /><path d="M6.5 11.5V16c1.6 1.5 3.5 2.2 5.5 2.2s3.9-.7 5.5-2.2v-4.5M21.5 9.5V14" /></>,
  bus: <><rect x="5" y="3.5" width="14" height="14" rx="3" /><path d="M5 11h14M8.5 14.5h.01M15.5 14.5h.01" /><path d="M7.5 17.5v2M16.5 17.5v2" /></>,
  bolt: <path d="M13 3 5.5 13.5H11L10 21l8.5-11H13l0-7Z" />,
  briefcase: <><rect x="3.5" y="7.5" width="17" height="11.5" rx="2.4" /><path d="M9 7.5V6a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 6v1.5M3.5 12.5h17" /></>,
  wifi: <><path d="M3.5 9.5a12 12 0 0 1 17 0M6.5 12.8a7.7 7.7 0 0 1 11 0M9.5 16a3.4 3.4 0 0 1 5 0" /><path d="M12 19.2h.01" strokeWidth="2.6" /></>,
  web: <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.4 2.4 3.6 5.2 3.6 8.5s-1.2 6.1-3.6 8.5c-2.4-2.4-3.6-5.2-3.6-8.5S9.6 5.9 12 3.5Z" /></>,
};

export type GlyphName = keyof typeof paths;

export default function Glyph({ name, size = 18 }: { name: GlyphName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}
