import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import "./globals.css";

const inter = Inter({ subsets: ["latin", "latin-ext", "vietnamese"], variable: "--font-inter", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap", weight: ["500"] });

export const metadata: Metadata = {
  metadataBase: new URL("https://withmano.com"),
  title: { default: "Mano", template: "%s | Mano" },
  description: "Your own agent applies for help, fills out any form, reads your mail from a photo, renews on time and waits on hold. You approve every step.",
  openGraph: { siteName: "Mano", type: "website" },
};

export const viewport: Viewport = { themeColor: "#131313", colorScheme: "dark" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body>
        <a href="#main" className="skip">Skip to content</a>
        <Header />
        <main id="main">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
