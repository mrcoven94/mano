const tones = {
  orange: "#FFB26B",
} as const;

export type Tone = keyof typeof tones;

type Props = {
  size?: number | string;
  tone?: Tone;
  tile?: boolean;
  wave?: boolean;
  className?: string;
};

/* The waving hand from the logo: four fingers, a thumb, a face on the palm. Drawn for Mano. */
export function Wave({ fill = "#FFFDF9", face = "#1B1814", blush = "#FF8F6B" }: { fill?: string; face?: string; blush?: string }) {
  return (
    <>
      <path fill={fill} d="M45 87C33 87 26 79 23 68L13 49C9 41 18 36 23 43L29 51V30C29 22 41 22 41 30V34Q42 37 43 34V20C43 12 55 12 55 20V34Q56 37 57 34V25C57 17 69 17 69 25V40Q70 43 71 40V36C71 28 83 28 83 36V58C83 75 72 87 56 87Z" />
      <ellipse cx="36" cy="65" rx="5" ry="3.5" fill={blush} />
      <ellipse cx="70" cy="65" rx="5" ry="3.5" fill={blush} />
      <circle cx="43" cy="58" r="3.2" fill={face} />
      <circle cx="63" cy="58" r="3.2" fill={face} />
      <path d="M47 68Q53 75 59 68" fill="none" stroke={face} strokeWidth="3" strokeLinecap="round" />
    </>
  );
}

/* Every use draws the orange tile. The tile and tone props stay so the call sites read as before. */
export default function Mascot({ size = 72, tone = "orange", wave = false, className }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" className={className} aria-hidden={true}>
      <rect width="100" height="100" rx="28" fill={tones[tone]} />
      <g className={wave ? "mascot-wave" : undefined}>
        <Wave blush="#FF8F6B" />
      </g>
    </svg>
  );
}
