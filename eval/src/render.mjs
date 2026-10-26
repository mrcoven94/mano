// Render letters as text and as phone-photo style images.
// Photo path: calls Muse Image (muse-image-1.0, synthetic data only) when
// META_MODEL_API_KEY is set; otherwise writes a deterministic local SVG
// that stands in for a phone photo so the pipeline runs offline at $0.
// Cost guard: photos only for PHOTO_HOUSEHOLDS households.
import { createHash } from "node:crypto";
import { PHOTO_HOUSEHOLDS } from "./generator.mjs";

export function renderText(letter) {
  return letter.text;
}
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
export function renderPhotoSvg(letter, householdId) {
  const lines = esc(letter.text).split("\n").slice(0, 14);
  const tspans = lines.map((l, i) => `<text x="36" y="${90 + i * 26}" font-size="15" fill="#222">${l.slice(0, 62)}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="960"><rect width="720" height="960" fill="#ddd6c3"/><rect x="24" y="24" width="672" height="912" rx="6" fill="#fffdf5" transform="rotate(-1 360 480)"/>${tspans}<text x="36" y="40" font-size="12" fill="#888">phone photo ${householdId} ${letter.letterId} (synthetic, local render)</text></svg>`;
}
export async function renderPhoto(letter, householdId, { fetchImpl = fetch } = {}) {
  const key = process.env.META_MODEL_API_KEY;
  if (key) {
    // Muse Image via Responses-compatible endpoint; synthetic data only.
    const res = await fetchImpl("https://api.meta.ai/v1/images", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "muse-image-1.0-contributor", prompt: `Phone photo of a benefits letter on a kitchen table, slightly tilted, readable text: ${letter.text.slice(0, 300)}`, store: false }),
    }).catch(() => null);
    if (res && res.ok) return { kind: "muse-image", householdId, letterId: letter.letterId };
    // Fall through to local render on any API failure; never block the eval.
  }
  return { kind: "local-svg", svg: renderPhotoSvg(letter, householdId), householdId, letterId: letter.letterId };
}
export function photoHouseholdIds(households) {
  return new Set(households.slice(0, PHOTO_HOUSEHOLDS).map((h) => h.householdId));
}
export function contentHash(obj) {
  return createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}
