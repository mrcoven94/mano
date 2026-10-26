/* Line drawings for the stacked cards. Drawn for Mano, slightly loose on purpose. */
const p = { fill: "none", stroke: "#141414", strokeWidth: 3, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export const Office = () => (
  <svg viewBox="0 0 150 130" width="100%" height="100%"><path {...p} d="M24 112 H128" /><path {...p} d="M36 110 V56 L76 30 L116 56 V110" /><path {...p} d="M58 110 V82 C58 78 61 76 64 76 H88 C91 76 94 78 94 82 V110" /><path {...p} d="M50 64 H102" /><circle {...p} cx="118" cy="30" r="12" /><path {...p} d="M112 30 L117 35 L125 25" /></svg>
);
export const People = () => (
  <svg viewBox="0 0 150 130" width="100%" height="100%"><circle {...p} cx="56" cy="44" r="16" /><path {...p} d="M26 108 C27 86 40 74 56 74 C72 74 85 86 86 108" /><circle {...p} cx="104" cy="50" r="13" /><path {...p} d="M94 76 C112 74 124 86 126 106" /></svg>
);
export const Policy = () => (
  <svg viewBox="0 0 150 130" width="100%" height="100%"><path {...p} d="M22 20 H62 L74 32 V110 H22 Z" /><path {...p} d="M32 46 H62 M32 60 H64 M32 74 H54" /><path {...p} d="M80 66 C92 66 92 50 104 50" /><path {...p} d="M98 44 L105 50 L98 57" /><rect {...p} x="108" y="34" width="26" height="22" rx="6" /><rect {...p} x="108" y="64" width="26" height="22" rx="6" /><rect {...p} x="108" y="94" width="26" height="22" rx="6" /><path {...p} d="M121 56 V64 M121 86 V94" /></svg>
);
export const Checklist = () => (
  <svg viewBox="0 0 150 130" width="100%" height="100%"><rect {...p} x="26" y="16" width="80" height="100" rx="12" /><path {...p} d="M40 42 L46 48 L56 36 M66 42 H92" /><path {...p} d="M40 66 L46 72 L56 60 M66 66 H92" /><path {...p} d="M40 90 L46 96 L56 84 M66 90 H84" /><path {...p} d="M108 52 C122 52 128 60 128 70 C128 80 120 86 112 86" /><path {...p} d="M118 80 L112 86 L118 92" /></svg>
);
export const Keyboard = () => (
  <svg viewBox="0 0 150 130" width="100%" height="100%"><rect {...p} x="20" y="18" width="110" height="68" rx="10" /><path {...p} d="M62 86 L56 106 H94 L88 86" /><path {...p} d="M34 38 H76 M34 52 H96 M34 66 H66" /><path {...p} d="M100 64 L110 74 L124 58" /></svg>
);
export const Speech = () => (
  <svg viewBox="0 0 150 130" width="100%" height="100%"><path {...p} d="M20 30 C20 22 26 18 34 18 H90 C98 18 104 22 104 30 V64 C104 72 98 76 90 76 H52 L34 92 V76 C26 76 20 72 20 64 Z" /><path {...p} d="M38 40 H86 M38 54 H72" /><path {...p} d="M112 54 H120 C126 54 130 58 130 64 V92 C130 98 126 102 120 102 V114 L106 102 H82 C76 102 72 98 72 92 V88" /></svg>
);
export const Folder = () => (
  <svg viewBox="0 0 150 130" width="100%" height="100%"><path {...p} d="M18 36 C18 30 22 26 28 26 H58 L70 38 H120 C126 38 130 42 130 48 V100 C130 106 126 110 120 110 H28 C22 110 18 106 18 100 Z" /><path {...p} d="M18 56 H130" /><circle {...p} cx="104" cy="84" r="12" /><path {...p} d="M104 78 V84 L108 88" /></svg>
);
export const Chase = () => (
  <svg viewBox="0 0 150 130" width="100%" height="100%"><rect {...p} x="18" y="50" width="40" height="52" rx="8" /><path {...p} d="M28 68 H48 M28 80 H42" /><path {...p} d="M66 62 C82 46 98 46 112 58" strokeDasharray="2 9" /><path {...p} d="M106 50 L113 58 L104 63" /><circle {...p} cx="118" cy="82" r="16" /><path {...p} d="M110 82 L116 88 L126 76" /></svg>
);
export const Coins = () => (
  <svg viewBox="0 0 150 130" width="100%" height="100%"><ellipse {...p} cx="62" cy="40" rx="32" ry="12" /><path {...p} d="M30 40 V62 C30 69 44 74 62 74 C80 74 94 69 94 62 V40" /><path {...p} d="M30 62 V84 C30 91 44 96 62 96 C70 96 77 95 82 93" /><circle {...p} cx="104" cy="90" r="24" /><path {...p} d="M104 78 V102 M96 84 C96 80 112 80 112 85 C112 90 96 90 96 95 C96 100 112 100 112 96" /></svg>
);
export const Puzzle = () => (
  <svg viewBox="0 0 150 130" width="100%" height="100%"><path {...p} d="M24 42 H52 C50 30 56 24 64 24 C72 24 78 30 76 42 H104 V68 C116 66 122 72 122 80 C122 88 116 94 104 92 V118 H24 Z" /><path {...p} d="M64 70 L72 78 L88 60" /></svg>
);
