/* One small drawn character per need, each with the mascot's face, and the sticker color it sits on. */

const INK = "#121212";

function Face({ x, y, w = 12 }: { x: number; y: number; w?: number }) {
  const h = w / 2;
  return (
    <g>
      <circle cx={x - h} cy={y} r="2.2" fill={INK} />
      <circle cx={x + h} cy={y} r="2.2" fill={INK} />
      <path d={`M${x - 3.5} ${y + 5}Q${x} ${y + 9} ${x + 3.5} ${y + 5}`} fill="none" stroke={INK} strokeWidth="2.4" strokeLinecap="round" />
    </g>
  );
}

const S = { stroke: INK, strokeWidth: 3, strokeLinejoin: "round" as const, strokeLinecap: "round" as const };

const ICONS: Record<string, React.ReactNode> = {
  rent: (
    <>
      <path {...S} fill="#FFB26B" d="M7 31L32 10L57 31" />
      <rect {...S} fill="#FFFDF9" x="14" y="27" width="36" height="28" rx="4" />
      <rect {...S} fill="#FFE14A" x="27" y="41" width="10" height="14" rx="3" />
      <Face x={32} y={33} />
    </>
  ),
  food: (
    <>
      <path {...S} fill="#FF8F6B" d="M32 20C22 12 9 18 11 34C13 50 24 57 32 52C40 57 51 50 53 34C55 18 42 12 32 20Z" />
      <path {...S} fill="none" d="M32 20L34 9" />
      <path {...S} fill="#5EEAA0" d="M35 13C39 6 47 6 49 9C45 14 39 15 35 13Z" />
      <Face x={32} y={33} />
    </>
  ),
  bills: (
    <>
      <path {...S} fill="none" d="M8 22H3M61 22H56M14 6L10 2M50 6L54 2" />
      <circle {...S} fill="#FFE14A" cx="32" cy="25" r="17" />
      <rect {...S} fill="#D6D3CC" x="24" y="42" width="16" height="12" rx="3" />
      <path {...S} d="M24 48H40" />
      <Face x={32} y={24} />
    </>
  ),
  medicine: (
    <g transform="rotate(-35 32 32)">
      <path {...S} fill="#FF8F6B" d="M32 21H21a11 11 0 0 0 0 22H32Z" />
      <path {...S} fill="#FFFDF9" d="M32 21H43a11 11 0 0 1 0 22H32Z" />
      <Face x={42} y={30} w={9} />
    </g>
  ),
  childcare: (
    <>
      <circle {...S} fill="#E3B27E" cx="15" cy="17" r="8" />
      <circle {...S} fill="#E3B27E" cx="49" cy="17" r="8" />
      <circle {...S} fill="#E3B27E" cx="32" cy="34" r="21" />
      <ellipse {...S} fill="#F7DFC3" cx="32" cy="42" rx="9" ry="7" />
      <circle cx="25" cy="31" r="2.4" fill={INK} />
      <circle cx="39" cy="31" r="2.4" fill={INK} />
      <path d="M29 41Q32 44 35 41" fill="none" stroke={INK} strokeWidth="2.4" strokeLinecap="round" />
    </>
  ),
  housing: (
    <>
      <path {...S} fill="none" d="M31 33L55 57M47 49L53 43M52 54L57 49" />
      <circle {...S} fill="#FFE14A" cx="22" cy="23" r="15" />
      <Face x={22} y={22} />
    </>
  ),
  credit: (
    <>
      <rect {...S} fill="#DCE3FB" x="6" y="15" width="52" height="36" rx="7" />
      <path {...S} d="M6 25H58" />
      <rect {...S} fill="#FFE14A" x="12" y="33" width="10" height="8" rx="2" />
      <Face x={42} y={37} />
    </>
  ),
  programs: (
    <>
      <path {...S} fill="#E4E0F5" d="M6 24L32 9L58 24Z" />
      <path {...S} fill="none" d="M14 28V48M26 28V48M38 28V48M50 28V48" />
      <rect {...S} fill="#E4E0F5" x="8" y="48" width="48" height="8" rx="2" />
      <Face x={32} y={17} w={9} />
    </>
  ),
  chat: (
    <>
      <path {...S} fill="#DCE3FB" d="M10 14H54A6 6 0 0 1 60 20V40A6 6 0 0 1 54 46H28L16 56V46H10A6 6 0 0 1 4 40V20A6 6 0 0 1 10 14Z" />
      <Face x={32} y={28} />
    </>
  ),
  clipboard: (
    <>
      <rect {...S} fill="#CFE3D6" x="12" y="10" width="40" height="48" rx="6" />
      <rect {...S} fill="#FFFDF9" x="22" y="5" width="20" height="10" rx="3" />
      <path {...S} d="M20 46H44" />
      <Face x={32} y={28} />
    </>
  ),
  calendar: (
    <>
      <rect {...S} fill="#FFFDF9" x="8" y="12" width="48" height="44" rx="7" />
      <path {...S} fill="#FF8F6B" d="M8 19A7 7 0 0 1 15 12H49A7 7 0 0 1 56 19V24H8Z" />
      <path {...S} d="M20 6V16M44 6V16" />
      <Face x={32} y={37} />
    </>
  ),
  now: (
    <>
      <path {...S} fill="none" d="M5 14L10 17M59 14L54 17M32 3V8" />
      <path {...S} fill="#FF8F6B" d="M32 55C16 44 8 35 8 25C8 17 14 12 21 12C26 12 30 15 32 19C34 15 38 12 43 12C50 12 56 17 56 25C56 35 48 44 32 55Z" />
      <Face x={32} y={28} />
    </>
  ),
};

export function NeedIcon({ k, size = 56 }: { k: string; size?: number }) {
  return <svg className="nd-icon" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">{ICONS[k]}</svg>;
}

export const NEED_TINT: Record<string, string> = {
  rent: "#FDEBD8", food: "#FDE3DA", bills: "#FFF4B8", medicine: "#FCE4EC", childcare: "#F2EADB",
  housing: "#FFF4B8", credit: "#DCE3FB", programs: "#E4E0F5", now: "#FFE14A",
};
