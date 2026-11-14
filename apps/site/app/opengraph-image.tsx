import { ImageResponse } from "next/og";
import { SMS_IS_PLACEHOLDER, SMS_NUMBER } from "@/lib/site";

export const alt = "Mano: text a photo of your renewal letter. Mano reads it, tracks the deadline and files after your yes.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", background: "#FFFFFF", padding: "72px 80px", color: "#121212" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <svg width="84" height="84" viewBox="0 0 100 100">
            <rect width="100" height="100" rx="28" fill="#FFB26B" />
            <path fill="#FFFDF9" d="M45 87C33 87 26 79 23 68L13 49C9 41 18 36 23 43L29 51V30C29 22 41 22 41 30V34Q42 37 43 34V20C43 12 55 12 55 20V34Q56 37 57 34V25C57 17 69 17 69 25V40Q70 43 71 40V36C71 28 83 28 83 36V58C83 75 72 87 56 87Z" />
            <ellipse cx="36" cy="65" rx="5" ry="3.5" fill="#FF8F6B" />
            <ellipse cx="70" cy="65" rx="5" ry="3.5" fill="#FF8F6B" />
            <circle cx="43" cy="58" r="3.2" fill="#1B1814" />
            <circle cx="63" cy="58" r="3.2" fill="#1B1814" />
            <path d="M47 68Q53 75 59 68" fill="none" stroke="#1B1814" strokeWidth="3" strokeLinecap="round" />
          </svg>
          <div style={{ fontSize: 64, fontWeight: 800, letterSpacing: "-0.05em" }}>Mano</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ fontSize: 76, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1.04, maxWidth: 980 }}>Text a photo of the letter you have been putting off.</div>
          <div style={{ fontSize: 34, color: "#55554F", lineHeight: 1.3, maxWidth: 960 }}>Mano reads it, tracks the deadline and files the renewal after your yes.</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 30 }}>
          <div style={{ display: "flex", background: "#2443D6", color: "#FFFFFF", borderRadius: 999, padding: "16px 32px", fontWeight: 700 }}>{SMS_IS_PLACEHOLDER ? "Text Mano" : `Text Mano at ${SMS_NUMBER}`}</div>
          <div style={{ display: "flex", color: "#6A6A64" }}>withmano.com</div>
        </div>
      </div>
    ),
    size,
  );
}
