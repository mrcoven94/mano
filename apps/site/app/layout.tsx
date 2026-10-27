import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Schibsted_Grotesk } from "next/font/google";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import "./globals.css";
import "./shared.css";
import "./sections.css";
import "./home.css";

const sans = Geist({ subsets: ["latin", "latin-ext"], variable: "--font-sans", display: "swap" });
const display = Schibsted_Grotesk({ subsets: ["latin", "latin-ext"], variable: "--font-display", display: "swap" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL("https://withmano.com"),
  title: { default: "Mano", template: "%s | Mano" },
  description: "Mano is AI that helps you pay rent, get food benefits, keep the lights on, afford medicine and find child care. It finds the help, fills out the forms and keeps it coming. You approve every step.",
  openGraph: { siteName: "Mano", type: "website" },
};

export const viewport: Viewport = { themeColor: "#FFFFFF", colorScheme: "light" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${display.variable} ${mono.variable}`}>
      <body>
        <a href="#main" className="skip">Skip to content</a>
        <Header />
        <main id="main">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
