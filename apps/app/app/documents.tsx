// Documents the agent holds: renewal packets, photographed mail and
// office notices, each exactly as it will be sent.

import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Body, Card, DemoBanner, EmptyView, ErrorView, LoadingView, Muted, Screen, Title } from "../components/ui";
import type { DocMeta } from "../lib/api/types";
import { AuthError, EngineGapError } from "../lib/api/types";
import { useAuth } from "../lib/auth";
import { useStrings } from "../lib/i18n";
import { colors, tapTarget, type } from "../lib/theme";

export default function Documents() {
  const s = useStrings();
  const router = useRouter();
  const { client, session, mode, signOut } = useAuth();
  const [docs, setDocs] = useState<DocMeta[] | null>(null);
  const [gap, setGap] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    setFailed(false);
    setGap(false);
    try {
      setDocs(await client.listDocuments(session));
    } catch (err) {
      if (err instanceof AuthError) {
        await signOut();
        return;
      }
      if (err instanceof EngineGapError) setGap(true);
      else setFailed(true);
    }
  }, [client, session, signOut]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  return (
    <Screen>
      <Title>{s.documentsTitle}</Title>
      {mode === "stand-in" ? <DemoBanner text={s.demoMode} /> : null}
      <Body>{s.documentsBody}</Body>
      <View style={styles.list}>
        {gap ? (
          <Card>
            <Text style={[type.cardTitle, styles.name]}>{s.engineGapTitle}</Text>
            <Body>{s.engineGapBody}</Body>
          </Card>
        ) : failed ? (
          <ErrorView title={s.errorTitle} body={s.errorBody} retry={() => void load()} retryTitle={s.retry} />
        ) : docs === null ? (
          <LoadingView />
        ) : docs.length === 0 ? (
          <EmptyView body={s.documentsEmpty} />
        ) : (
          docs.map((d) => (
            <Pressable
              key={d.id}
              onPress={() => router.push({ pathname: "/documents/[id]", params: { id: d.id } })}
              accessibilityRole="button"
              style={styles.row}
            >
              <Ionicons name="document-text-outline" size={22} color={colors.text} />
              <View style={styles.rowText}>
                <Text style={[type.cardTitle, styles.name]} numberOfLines={1}>
                  {d.name}
                </Text>
                <Muted>{d.hash.slice(0, 12)}…</Muted>
              </View>
              <Ionicons name="chevron-forward-outline" size={20} color={colors.faint} />
            </Pressable>
          ))
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { marginTop: 16 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: tapTarget,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 8,
  },
  rowText: { flex: 1 },
  name: { color: colors.text },
});
