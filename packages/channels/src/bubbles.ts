// Splits a reply into a few short bubbles at sentence boundaries.

const SENTENCE_END = /([.!?…]+["”’)]?\s+)/;

export function splitBubbles(text: string, maxBubbles = 4, maxCharsPerBubble = 500): string[] {
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
    for (let i = 0; i < sentence.length; i += maxCharsPerBubble) {
      bubbles.push(sentence.slice(i, i + maxCharsPerBubble).trim());
    }
    current = "";
  }
  if (current) bubbles.push(current);
  if (bubbles.length <= maxBubbles) return bubbles;
  const head = bubbles.slice(0, maxBubbles - 1);
  head.push(bubbles.slice(maxBubbles - 1).join(" "));
  return head;
}
