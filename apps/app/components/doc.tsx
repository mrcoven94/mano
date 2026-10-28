// Renders the exact bytes behind an approval or a document: text reads
// as text, photos show as photos, PDFs show every page. The engine
// serves every file as octet-stream, so unknown types are sniffed from
// magic bytes, never trusted from the name. Formats this phone cannot
// show render as an honest fallback, and the approval screen keeps
// Approve disabled until the document has actually been shown.

import { useEffect, useState } from "react";
import { ActivityIndicator, Image, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { File, Paths } from "expo-file-system";
import { deleteAsync } from "expo-file-system/legacy";
import { b64ToUtf8, b64decode } from "../lib/base64";
import type { ApprovalDocument } from "../lib/api/types";
import { canShowInApp, type DocPlatform } from "../lib/doc-show";
import { colors, radius, type } from "../lib/theme";

function magic(bytes: Uint8Array): string {
  const head = [...bytes.slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (head.startsWith("89504e47")) return "image/png";
  if (head.startsWith("ffd8ff")) return "image/jpeg";
  if (head.startsWith("25504446")) return "application/pdf";
  if (head.startsWith("47494638")) return "image/gif";
  return "";
}

function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.slice(0, 2000);
  if (sample.length === 0) return false;
  let printable = 0;
  for (const b of sample) {
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 128) printable += 1;
  }
  return printable / sample.length > 0.95;
}

export function sniffMime(doc: ApprovalDocument): string {
  if (doc.mimeType !== "application/octet-stream") return doc.mimeType;
  const bytes = b64decode(doc.bytesB64);
  return magic(bytes) || (looksLikeText(bytes) ? "text/plain" : "application/octet-stream");
}

export function currentPlatform(): DocPlatform {
  if (Platform.OS === "web") return "web";
  if (Platform.OS === "ios") return "ios";
  return "android";
}

export function shortHash(hash: string): string {
  return hash.length > 16 ? `${hash.slice(0, 8)}…${hash.slice(-8)}` : hash;
}

function PdfView({ doc }: { doc: ApprovalDocument }) {
  const [uri, setUri] = useState<string | null>(Platform.OS === "web" ? `data:application/pdf;base64,${doc.bytesB64}` : null);
  useEffect(() => {
    if (Platform.OS === "web") {
      setUri(`data:application/pdf;base64,${doc.bytesB64}`);
      return;
    }
    let cancelled = false;
    let file: File | null = null;
    const prepare = async (): Promise<void> => {
      try {
        file = new File(Paths.cache, `mano-preview-${doc.id.replace(/[^A-Za-z0-9_-]+/g, "_")}.pdf`);
        const writer = file.writableStream().getWriter();
        await writer.write(b64decode(doc.bytesB64));
        await writer.close();
        if (!cancelled) setUri(file.uri);
      } catch {
        if (!cancelled) setUri(null);
      }
    };
    void prepare();
    return () => {
      cancelled = true;
      if (file) void deleteAsync(file.uri, { idempotent: true }).catch(() => {});
    };
  }, [doc]);
  if (!uri) {
    return (
      <View style={styles.pdfLoading}>
        <ActivityIndicator size="large" color={colors.text} />
      </View>
    );
  }
  return <WebView source={{ uri }} style={styles.pdf} originWhitelist={["*"]} />;
}

export function DocPreview({ doc }: { doc: ApprovalDocument }) {
  const mime = sniffMime(doc);
  if (!canShowInApp(mime, currentPlatform())) {
    return (
      <View style={styles.fallback}>
        <Text style={[type.small, styles.fallbackText]}>
          {doc.name} · {Math.ceil((doc.bytesB64.length * 3) / 4)} bytes
        </Text>
      </View>
    );
  }
  if (mime === "application/pdf") return <PdfView doc={doc} />;
  if (mime.startsWith("image/")) {
    return (
      <Image
        source={{ uri: `data:${mime};base64,${doc.bytesB64}` }}
        style={styles.image}
        resizeMode="contain"
        accessibilityLabel={doc.name}
      />
    );
  }
  return (
    <ScrollView style={styles.textBox} nestedScrollEnabled>
      <Text style={styles.text}>{b64ToUtf8(doc.bytesB64)}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  image: { width: "100%", height: 260, borderRadius: radius.sm, backgroundColor: colors.bg2 },
  textBox: { maxHeight: 260, backgroundColor: colors.bg2, borderRadius: radius.sm, padding: 12 },
  text: { fontSize: 14, lineHeight: 20, color: colors.text },
  fallback: { backgroundColor: colors.bg2, borderRadius: radius.sm, padding: 12 },
  fallbackText: { color: colors.muted },
  pdf: { height: 420, borderRadius: radius.sm, backgroundColor: colors.bg2 },
  pdfLoading: { height: 200, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg2, borderRadius: radius.sm },
});
