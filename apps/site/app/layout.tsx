import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Schibsted_Grotesk } from "next/font/google";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import RenewalBanner from "@/components/RenewalBanner";
import { BANNER_ATTR, BANNER_KEY } from "@/lib/site";
import "./globals.css";
import "./home.css";
import "./teams.css";

const sans = Geist({ subsets: ["latin", "latin-ext"], variable: "--font-sans", display: "swap" });
const display = Schibsted_Grotesk({ subsets: ["latin", "latin-ext"], variable: "--font-display", display: "swap" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL("https://withmano.com"),
  title: { default: "Mano", template: "%s | Mano" },
  description: "Mano is AI that helps you pay rent, get food benefits, keep the lights on, afford medicine and find child care. It finds the help, fills out the forms and keeps it coming.",
  openGraph: { siteName: "Mano", type: "website" },
};

export const viewport: Viewport = { themeColor: "#FFFFFF", colorScheme: "light" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${display.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `try{if(localStorage.getItem(${JSON.stringify(BANNER_KEY)})==="off")document.documentElement.setAttribute(${JSON.stringify(BANNER_ATTR)},"")}catch(e){}` }} />
      </head>
      <body>
        <a href="#main" className="skip">Skip to content</a>
        <RenewalBanner />
        <Header />
        <main id="main">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
