// The judge run's copy of Maria's replay page. Engine renders the page a
// person sees (apps/engine/src/fill-replay.ts) and this only adds to it, so
// the production page stays exactly as Engine writes it: a banner saying
// this is a judge run on synthetic data and listing every part of the run
// that was simulated, and a label under each simulated item on the page
// (each screen, the filled form, and the line that says Maria said yes).
// Every addition is one <div class="judge-label">, so removing those gives
// Engine's page back. A page whose shape no longer has a place for a label
// throws, so a label is never silently dropped.

const SCREEN = "Simulated: a screen drawn by the stand-in for Mano's computer, not a screenshot of a real fill.";
const YES = "Simulated: Maria is synthetic, and this run scripted her YES.";

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const label = (text: string) => `<div class="judge-label"><p><strong>${escapeHtml(text)}</strong></p></div>`;

// simulated: what the run simulated, as its steps labeled them.
export function labelReplayPage(html: string, simulated: string[]): string {
  const banner =
    `<div class="judge-label"><p><strong>Judge run on synthetic data.</strong> This page was written by pnpm judge, not sent to a person. ` +
    `Maria is synthetic. These parts of the run were simulated:</p><ul>${simulated.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul></div>`;
  let steps = 0;
  const out = html
    .replace(/<main>/, () => `<main>${banner}`)
    .replace(/(<\/h1><p>[^<]*<\/p>)/, (m) => `${m}${label(YES)}`)
    .replace(/(<li><p>\d+\. [^<]*<\/p>)/g, (m) => {
      steps += 1;
      return `${m}${label(SCREEN)}`;
    })
    .replace(/(<h2>The filled form<\/h2>)/, (m) => `${m}${label(SCREEN)}`);
  const added = out.split('<div class="judge-label">').length - 1;
  if (!out.includes(banner) || !out.includes(label(YES)) || steps === 0) {
    throw new Error("The replay page has no place for the judge run's labels.");
  }
  if (added !== steps + 2 + (out.includes("<h2>The filled form</h2>") ? 1 : 0)) {
    throw new Error("The replay page did not take every judge run label.");
  }
  return out;
}

// Engine's page as it was before labelReplayPage, for tests.
export function withoutJudgeLabels(html: string): string {
  return html.replace(/<div class="judge-label">[\s\S]*?<\/div>/g, "");
}
