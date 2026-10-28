// Whether a document can be shown in full, in the app, on this
// platform. Text and images render everywhere; PDFs render on web and
// iOS but not in the Android webview. Anything else, including unknown
// bytes, is not shown, and the approval screen keeps Approve disabled.

export type DocPlatform = "web" | "ios" | "android";

export function canShowInApp(mime: string, platform: DocPlatform): boolean {
  if (mime.startsWith("image/") || mime.startsWith("text/")) return true;
  if (mime === "application/pdf") return platform !== "android";
  return false;
}
