/* Partner companies stay unnamed until David confirms in writing that they agreed (AGENTS.md rule 9).
   Set a name here once that is confirmed; the cards pick it up. */
export type Partner = { name: string | null };

export const PARTNER_CREDIT: Partner = { name: null };
export const PARTNER_EBT: Partner = { name: null };

export const withPartner = (p: Partner) => (p.name ? ` with ${p.name}` : "");
