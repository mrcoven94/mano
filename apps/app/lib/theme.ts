// Shared look for the resident app. Tokens come from the marketing site
// (apps/site/app/globals.css): paper, ink, a yellow highlighter and a blue
// ballpoint. The app never invents its own palette.

export const colors = {
  bg: "#FFFFFF",
  bg2: "#F6F5F2",
  bg3: "#EEECE7",
  card: "#FFFFFF",
  text: "#121212",
  muted: "#55554F",
  faint: "#6A6A64",
  border: "#E7E5E0",
  border2: "#D6D3CC",
  pen: "#2443D6",
  penSoft: "#E9EDFC",
  hl: "#FFE14A",
  envelope: "#F2EADB",
  alert: "#B42318",
  alertSoft: "#FDECEA",
  green: "#1F7A4D",
  greenSoft: "#E3EFE8",
  ink: "#FFFFFF",
} as const;

export const radius = {
  sm: 12,
  md: 16,
  lg: 22,
  pill: 999,
} as const;

// Tap targets stay at least 48px tall on every screen.
export const tapTarget = 48;

export const fonts = {
  display: "SchibstedGrotesk_700Bold",
  displayMedium: "SchibstedGrotesk_500Medium",
  sans: "Geist_400Regular",
  sansMedium: "Geist_500Medium",
  sansBold: "Geist_700Bold",
} as const;

export const type = {
  title: { fontFamily: fonts.display, fontSize: 28, lineHeight: 32, letterSpacing: -0.5 },
  section: { fontFamily: fonts.display, fontSize: 20, lineHeight: 24, letterSpacing: -0.3 },
  cardTitle: { fontFamily: fonts.sansBold, fontSize: 16, lineHeight: 22 },
  body: { fontFamily: fonts.sans, fontSize: 16, lineHeight: 24 },
  small: { fontFamily: fonts.sans, fontSize: 14, lineHeight: 20 },
  caption: { fontFamily: fonts.sans, fontSize: 12, lineHeight: 16 },
} as const;
