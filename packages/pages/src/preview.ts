// Link previews. Titles and descriptions stay generic so an unfurl in a
// text thread never shows personal details. The one exception is the
// estimate title, which names the program ("Your SNAP estimate"). Amounts,
// names, facts and deadlines never appear here.

import type { ValidatedPage } from "./types.js";

export interface PagePreview {
  title: string;
  description: string;
}

export function pagePreview(page: ValidatedPage): PagePreview {
  switch (page.kind) {
    case "estimate":
      return {
        title: `Your ${page.program} estimate`,
        description: "A likely range, the math behind it, and what to do next.",
      };
    case "letter":
      return {
        title: "Your letter, read back",
        description: "What it says in plain words, and the one date that matters.",
      };
    case "checklist":
      return {
        title: "Your checklist",
        description: "Tick things off as you go. Mano saves your place.",
      };
    case "review":
      return {
        title: "Your form draft",
        description: "Check each field before anything goes anywhere.",
      };
    case "approve":
      return {
        title: "Your call",
        description: "Mano needs your yes before it acts.",
      };
  }
}
