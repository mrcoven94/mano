// One document in full. Share saves a copy through the system sheet;
// the bytes shown are the bytes the agent holds. Links in the preview
// go through the engine's link check before they open anywhere.

import { useCallback, useState } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { File, Paths } from "expo-file-system";
import * as Linking from "expo-linking";
import * as Sharing from "expo-sharing";
import { DocPreview } from "../../components/doc";
import { shortHash } from "../../lib/doc-show";
import { Body, Card, ErrorView, GhostBtn, LoadingView, Muted, Screen, Title } from "../../components/ui";
import { b64decode } from "../../lib/base64";
import type { ApprovalDocument } from "../../lib/api/types";
import { AuthError } from "../../lib/api/types";
import { useAuth, useClearOnSignOut } from "../../lib/auth";
import { trackCacheFile } from "../../lib/cache-files";
import { useStrings } from "../../lib/i18n";
import { colors, type } from "../../lib/theme";

export default function DocumentViewer() {
  const s = useStrings();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { client, session, personStore, signOut } = useAuth();
  const [doc, setDoc] = useState<ApprovalDocument | null>(null);
  const [failed, setFailed] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [linkBlocked, setLinkBlocked] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    setFailed(false);
    setLinkBlocked(false);
    try {
      setDoc(await client.downloadDocument(session, id ?? ""));
    } catch (err) {
      if (err instanceof AuthError) {
        await signOut();
        return;
      }
      setFailed(true);
    }
  }, [client, session, id, signOut]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // The loaded bytes belong to the session. When it ends the viewer
  // forgets them at once, even before the route gate moves away.
  useClearOnSignOut(() => {
    setDoc(null);
    setLinkBlocked(false);
  });

  const handleLink = useCallback(
    async (url: string) => {
      if (!session) return;
      try {
        const verdict = await client.checkLink(session, url);
        if (!verdict.allowed) {
          setLinkBlocked(true);
          return;
        }
        await Linking.openURL(url);
      } catch {
        // If the safety check itself fails, the link stays shut.
        setLinkBlocked(true);
      }
    },
    [client, session],
  );

  const share = async (): Promise<void> => {
    if (!doc || !session || Platform.OS === "web") return;
    setSharing(true);
    try {
      if (!(await Sharing.isAvailableAsync())) return;
      const file = new File(Paths.cache, doc.name.replace(/[^A-Za-z0-9._-]+/g, "_"));
      const writer = file.writableStream().getWriter();
      await writer.write(b64decode(doc.bytesB64));
      await writer.close();
      if (personStore) await trackCacheFile(personStore, file.uri).catch(() => {});
      await Sharing.shareAsync(file.uri);
    } catch {
      // The sheet closed or sharing failed; the document stays put.
    } finally {
      setSharing(false);
    }
  };

  return (
    <Screen>
      <Title>{s.documentsTitle}</Title>
      {failed ? (
        <ErrorView title={s.errorTitle} body={s.errorBody} retry={() => void load()} retryTitle={s.retry} />
      ) : !doc ? (
        <LoadingView />
      ) : (
        <View>
          <Card>
            <Text style={[type.cardTitle, styles.name]}>{doc.name}</Text>
            <Muted>
              {s.docHash}: {shortHash(doc.hash)}
            </Muted>
            <View style={styles.preview}>
              <DocPreview
                doc={doc}
                cacheStore={personStore ?? undefined}
                onLink={(url) => void handleLink(url)}
              />
            </View>
            {linkBlocked ? <Muted style={styles.warn}>{s.linkBlocked}</Muted> : null}
          </Card>
          {Platform.OS !== "web" ? (
            <GhostBtn title={sharing ? s.sending : s.share} onPress={() => void share()} />
          ) : (
            <Body>{s.documentsBody}</Body>
          )}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  name: { color: colors.text, marginBottom: 4 },
  preview: { marginTop: 12 },
  warn: { color: colors.alert, marginTop: 8 },
});
