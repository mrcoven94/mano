import { createElement, useEffect, useState } from "react";
import { Image, Platform, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { WebView } from "react-native-webview";
import type { ShouldStartLoadRequest } from "react-native-webview/lib/WebViewTypes";
import type { ApprovalDocument } from "../lib/api/types";
import { b64ToUtf8 } from "../lib/base64";
import { trackCacheFile, untrackCacheFile } from "../lib/cache-files";
import { canShowInApp, navigationAllowed, sniffMime, type DocPlatform } from "../lib/doc-show";
import type { KeyValue } from "../lib/kv";
import { useStrings } from "../lib/i18n";
import { colors } from "../lib/theme";

interface PreviewProps {
  doc: ApprovalDocument;
  cacheStore?: KeyValue;
  onShown?: (shown: boolean) => void;
  onLink?: (url: string) => void;
}

export function currentPlatform(): DocPlatform {
  if (Platform.OS === "android") return "android";
  if (Platform.OS === "ios") return "ios";
  return "web";
}

function safeMime(mimeType: string, bytesB64: string): string | null {
  try {
    return sniffMime(mimeType, bytesB64);
  } catch {
    return null;
  }
}

export function DocPreview({ doc, cacheStore, onShown, onLink }: PreviewProps) {
  const mime = safeMime(doc.mimeType, doc.bytesB64);
  const showable = mime !== null && canShowInApp(mime, currentPlatform());
  // Unviewable documents report as not shown so the approval gate holds.
  useEffect(() => {
    if (!showable) onShown?.(false);
  }, [doc.id, showable, onShown]);
  if (!mime || !showable) return <PreviewFallback doc={doc} />;
  if (mime === "application/pdf") return <PdfView doc={doc} cacheStore={cacheStore} onShown={onShown} onLink={onLink} />;
  if (mime.startsWith("image/"))
    return (
      <Image
        source={{ uri: `data:${mime};base64,${doc.bytesB64}` }}
        style={{ width: "100%", height: 320, borderRadius: 8 }}
        resizeMode="contain"
        accessibilityLabel={doc.name}
        onLoad={() => onShown?.(true)}
        onError={() => onShown?.(false)}
      />
    );
  return <TextView doc={doc} onShown={onShown} />;
}

function TextView({ doc, onShown }: { doc: ApprovalDocument; onShown?: (shown: boolean) => void }) {
  let text: string | null = null;
  try {
    text = b64ToUtf8(doc.bytesB64);
  } catch {
    text = null;
  }
  useEffect(() => {
    onShown?.(text !== null);
  }, [doc.id, text, onShown]);
  if (text === null) return <PreviewFallback doc={doc} />;
  return (
    <ScrollView style={{ maxHeight: 320, borderRadius: 8, backgroundColor: colors.bg2 }} nestedScrollEnabled>
      <Text selectable style={{ padding: 12, fontSize: 15, lineHeight: 22, color: colors.text }}>
        {text}
      </Text>
    </ScrollView>
  );
}

function PreviewFallback({ doc }: { doc: ApprovalDocument }) {
  const s = useStrings();
  return (
    <View style={{ borderRadius: 8, backgroundColor: colors.bg2, padding: 16 }}>
      <Text style={{ fontSize: 16, fontWeight: "600", color: colors.text }}>{doc.name}</Text>
      <Text style={{ marginTop: 8, fontSize: 14, color: colors.text }}>{s.docCannotShow}</Text>
    </View>
  );
}

function PdfView({
  doc,
  cacheStore,
  onShown,
  onLink,
}: {
  doc: ApprovalDocument;
  cacheStore?: KeyValue;
  onShown?: (shown: boolean) => void;
  onLink?: (url: string) => void;
}) {
  if (Platform.OS === "web") return <WebPdf doc={doc} onShown={onShown} />;
  return <NativePdf doc={doc} cacheStore={cacheStore} onShown={onShown} onLink={onLink} />;
}

// Sandboxed so nothing inside the document can navigate anywhere: no
// scripts, no top navigation, no popups. Links in the PDF simply do
// not open on the web.
function WebPdf({ doc, onShown }: { doc: ApprovalDocument; onShown?: (shown: boolean) => void }) {
  const { width } = useWindowDimensions();
  const height = Math.max(360, Math.min(560, Math.round(width * 1.1)));
  return createElement("iframe", {
    src: `data:application/pdf;base64,${doc.bytesB64}`,
    sandbox: "allow-same-origin",
    title: doc.name,
    onLoad: () => onShown?.(true),
    onError: () => onShown?.(false),
    style: { width: "100%", height, borderWidth: 0, borderRadius: 8, backgroundColor: colors.bg2 },
  });
}

function NativePdf({
  doc,
  cacheStore,
  onShown,
  onLink,
}: {
  doc: ApprovalDocument;
  cacheStore?: KeyValue;
  onShown?: (shown: boolean) => void;
  onLink?: (url: string) => void;
}) {
  const s = useStrings();
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let fileUri: string | null = null;
    void (async () => {
      const { File, Paths } = await import("expo-file-system");
      const { b64decode } = await import("../lib/base64");
      const file = new File(Paths.cache, `mano-doc-${doc.id}.pdf`);
      const writer = file.writableStream().getWriter();
      await writer.write(b64decode(doc.bytesB64));
      await writer.close();
      fileUri = file.uri;
      if (cacheStore) await trackCacheFile(cacheStore, fileUri);
      if (live) setUri(fileUri);
    })().catch(() => {
      if (live) onShown?.(false);
    });
    return () => {
      live = false;
      if (fileUri) {
        const stale = fileUri;
        void (async () => {
          const { File } = await import("expo-file-system");
          if (cacheStore) await untrackCacheFile(cacheStore, stale);
          new File(stale).delete();
        })().catch(() => undefined);
      }
    };
  }, [doc.id]);
  if (!uri) return <Text style={{ color: colors.muted }}>{s.loadingDocument}</Text>;
  return (
    <View style={{ height: 420, borderRadius: 8, overflow: "hidden" }}>
      <WebView
        source={{ uri }}
        originWhitelist={["*"]}
        onShouldStartLoadRequest={(request: ShouldStartLoadRequest) => {
          if (navigationAllowed(request.url, uri)) return true;
          onLink?.(request.url);
          return false;
        }}
        onLoad={() => onShown?.(true)}
        onError={() => onShown?.(false)}
        onHttpError={() => onShown?.(false)}
      />
    </View>
  );
}
