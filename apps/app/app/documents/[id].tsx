// One document in full. Share saves a copy through the system sheet;
// the bytes shown are the bytes the agent holds.

import { useCallback, useState } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { DocPreview, shortHash } from "../../components/doc";
import { Body, Card, ErrorView, GhostBtn, LoadingView, Muted, Screen, Title } from "../../components/ui";
import { b64decode } from "../../lib/base64";
import type { ApprovalDocument } from "../../lib/api/types";
import { AuthError } from "../../lib/api/types";
import { useAuth } from "../../lib/auth";
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

  const load = useCallback(async () => {
    if (!session) return;
    setFailed(false);
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

  const share = async (): Promise<void> => {
    if (!doc || Platform.OS === "web") return;
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
              <DocPreview doc={doc} />
            </View>
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
});
