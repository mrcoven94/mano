const tones = {
  cyan: "#67e8f9",
  blue: "#7cb3ff",
  green: "#5eeaa0",
  orange: "#ffb26b",
  light: "#f2f2ef",
} as const;

export type Tone = keyof typeof tones;

type Props = {
  size?: number | string;
  tone?: Tone;
  tile?: boolean;
  wave?: boolean;
  label?: string;
  className?: string;
};

/* An open helping hand with a face on the palm. Drawn for Mano. */
export function Hand({ fill = "#f2f2ef", face = "#141414", blush = "#ffb26b" }: { fill?: string; face?: string; blush?: string }) {
  return (
    <>
      <g fill={fill}>
        <rect x="11.5" y="50" width="13" height="32" rx="6.5" transform="rotate(-46 18 66)" />
        <rect x="26.5" y="17" width="12.5" height="44" rx="6.25" transform="rotate(-9 32.75 39)" />
        <rect x="41" y="9" width="13" height="50" rx="6.5" />
        <rect x="56" y="13" width="12.5" height="46" rx="6.25" transform="rotate(7 62.25 36)" />
        <rect x="69.5" y="25" width="11" height="36" rx="5.5" transform="rotate(17 75 43)" />
        <path d="M24 60 C24 50 32 45 40 45 H66 C74 45 80 51 80 60 V68 C80 81 69 91 54 91 H50 C35 91 24 81 24 68 Z" />
      </g>
      <circle cx="44.5" cy="65" r="3.4" fill={face} />
      <circle cx="59.5" cy="65" r="3.4" fill={face} />
      <path d="M46 73.5 C49.5 77.5 54.5 77.5 58 73.5" fill="none" stroke={face} strokeWidth="2.6" strokeLinecap="round" />
      <ellipse cx="37" cy="72" rx="4" ry="2.8" fill={blush} opacity=".6" />
      <ellipse cx="67" cy="72" rx="4" ry="2.8" fill={blush} opacity=".6" />
    </>
  );
}

export default function Mascot({ size = 72, tone = "light", tile = false, wave = false, label, className }: Props) {
  const a11y = label ? { role: "img" as const, "aria-label": label } : { "aria-hidden": true as const };
  if (tile) {
    return (
      <svg width={size} height={size} viewBox="0 0 100 100" className={className} {...a11y}>
        <rect width="100" height="100" rx="28" fill={tones[tone]} />
        <g transform="translate(13 12) scale(.74)">
          <g className={wave ? "mascot-wave" : undefined}>
            <Hand fill="#fbfaf6" blush={tone === "orange" ? "#ff8f6b" : "#ffb26b"} />
          </g>
        </g>
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" className={className} {...a11y}>
      <g className={wave ? "mascot-wave" : undefined}>
        <Hand fill={tones[tone]} />
      </g>
    </svg>
  );
}
