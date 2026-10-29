// The tool contract for the agent (LAP-613). The agent calls show_page
// with a kind and data; it gets back the url and the one line text to
// send with it. Text is private to the person, so it may name specifics.
// Link previews are a separate path (see preview.ts) and stay generic.

import type { PageKind, ValidatedPage } from "./types.js";

export interface ShowPageInput {
  kind: PageKind;
  data: unknown;
}

export interface ShowPageResult {
  url: string;
  text: string;
}

function money(n: number): string {
  const rounded = Math.round(n);
  return `$${rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

function shorten(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max).replace(/\s+\S*$/, "");
  return `${cut === "" ? s.slice(0, max) : cut}...`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDate(iso: string): string {
  const parts = iso.split("-");
  const month = MONTHS[Number(parts[1]) - 1] ?? "";
  const day = String(Number(parts[2]));
  return `${month} ${day}`;
}

export function showPageText(page: ValidatedPage, url: string): string {
  switch (page.kind) {
    case "estimate":
      return (
        `Your ${page.program} estimate is ready: about ${money(page.rangeLow)} ` +
        `to ${money(page.rangeHigh)} ${page.period}. The math is here: ${url}`
      );
    case "letter": {
      const due = page.deadline ? ` Due date: ${shortDate(page.deadline.date)}.` : "";
      return `I read your letter from ${page.from}.${due} What it says and what to do is here: ${url}`;
    }
    case "checklist": {
      const left = page.items.filter((i) => !i.checked).length;
      const count = left === 1 ? "1 thing" : `${left} things`;
      return `Your checklist "${shorten(page.title, 60)}" is ready with ${count} to do. Tick them off here: ${url}`;
    }
    case "review": {
      const unsure = page.fields.filter((f) => f.unsure).length;
      const flag = unsure === 0 ? "Nothing looks off." : `${unsure} ${unsure === 1 ? "field needs" : "fields need"} your eye.`;
      return `Your ${shorten(page.formName, 60)} draft is ready to check. ${flag} Review it here: ${url}`;
    }
    case "approve":
      return `Before I ${shorten(page.action, 90)}, I need your yes. It takes seconds here: ${url}`;
  }
}
