// Splits a reply into a few short bubbles at sentence boundaries. Every
// bubble is hard-capped: overflow is cut, never merged into a giant last
// bubble. Splits never land inside a word or URL: a link broken across
// bubbles would dodge the per-bubble link check, and a broken word reads
// as a typo. The one exception is an over-long atom (a single word or
// URL past the cap), which goes whole into its own bubble.

export const MAX_BUBBLES = 4;
export const MAX_BUBBLE_CHARS = 600;

const SENTENCE_END = /([.!?…]+["”’)]?\s+)/;

export function splitBubbles(text: string, maxBubbles = MAX_BUBBLES, maxCharsPerBubble = MAX_BUBBLE_CHARS): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const sentences = clean
    .split(SENTENCE_END)
    .reduce<string[]>((acc, part, i, arr) => {
      if (i % 2 === 0 && part) acc.push(part + (arr[i + 1] ?? ""));
      return acc;
    }, [])
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const chunks = sentences.length > 0 ? sentences : [clean];
  const bubbles: string[] = [];
  let current = "";
  for (const sentence of chunks) {
    const next = current ? `${current} ${sentence}` : sentence;
    if (next.length <= maxCharsPerBubble) {
      current = next;
      continue;
    }
    if (current) bubbles.push(current);
    if (sentence.length <= maxCharsPerBubble) {
      current = sentence;
      continue;
    }
    // Over-long sentence: pack whole words. An over-long atom stays
    // whole in its own bubble rather than splitting mid-word.
    current = "";
    for (const word of sentence.split(" ")) {
      if (!word) continue;
      if (!current) {
        if (word.length <= maxCharsPerBubble) {
          current = word;
        } else {
          bubbles.push(word);
        }
        continue;
      }
      const grown = `${current} ${word}`;
      if (grown.length <= maxCharsPerBubble) {
        current = grown;
        continue;
      }
      bubbles.push(current);
      if (word.length <= maxCharsPerBubble) {
        current = word;
      } else {
        bubbles.push(word);
        current = "";
      }
    }
  }
  if (current) bubbles.push(current);
  if (bubbles.length <= maxBubbles) return bubbles;
  // Overflow: keep whole words up to the cap, drop the rest entirely.
  // Cutting mid-word here would manufacture a broken tail link.
  const head = bubbles.slice(0, maxBubbles - 1);
  const tailWords = bubbles
    .slice(maxBubbles - 1)
    .join(" ")
    .split(" ")
    .filter((w) => w.length > 0);
  let tail = "";
  for (const word of tailWords) {
    const next = tail ? `${tail} ${word}` : word;
    if (next.length > maxCharsPerBubble) break;
    tail = next;
  }
  head.push(tail || tailWords[0] || "");
  return head.filter((b) => b.length > 0);
}
