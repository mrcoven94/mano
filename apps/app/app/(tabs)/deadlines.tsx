// Deadlines the agent built from mail and office letters, soonest
// first. Each one links to its approval when one is waiting.

import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Badge, Card, DemoBanner, EmptyView, ErrorView, LoadingView, Muted, Screen, Title } from "../../components/ui";
import type { Deadline } from "../../lib/api/types";
import { EngineGapError } from "../../lib/api/types";
import { Body } from "../../components/ui";
import { useAuth } from "../../lib/auth";
import { daysUntil, formatDate } from "../../lib/dates";
import { useLanguage, useStrings } from "../../lib/i18n";
import { colors, type } from "../../lib/theme";

function countdown(s: ReturnType<typeof useStrings>, dueAt: string): { text: string; tone: "hl" | "alert" | "green" | "blue" } {
  const days = daysUntil(dueAt);
  if (days < 0) return { text: s.overdue, tone: "alert" };
  if (days === 0) return { text: s.dueToday, tone: "alert" };
  if (days === 1) return { text: s.dueTomorrow, tone: "hl" };
  return { text: `${days} ${s.dueInDays}`, tone: days <= 7 ? "hl" : "blue" };
}

export default function Deadlines() {
  const s = useStrings();
  const { language } = useLanguage();
  const router = useRouter();
  const { client, session, mode } = useAuth();
  const [deadlines, setDeadlines] = useState<Deadline[] | null>(null);
  const [gap, setGap] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    setFailed(false);
    setGap(false);
    try {
      const all = await client.listDeadlines(session);
      setDeadlines([...all].sort((a, b) => a.dueAt.localeCompare(b.dueAt)));
    } catch (err) {
      if (err instanceof EngineGapError) setGap(true);
      else setFailed(true);
    }
  }, [client, session]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  return (
    <Screen>
      <Title>{s.deadlinesTitle}</Title>
      {mode === "stand-in" ? <DemoBanner text={s.demoMode} /> : null}
      {gap ? (
        <Card>
          <Text style={[type.cardTitle, styles.title]}>{s.engineGapTitle}</Text>
          <Body>{s.engineGapBody}</Body>
        </Card>
      ) : failed ? (
        <ErrorView title={s.errorTitle} body={s.errorBody} retry={() => void load()} retryTitle={s.retry} />
      ) : deadlines === null ? (
        <LoadingView />
      ) : deadlines.length === 0 ? (
        <EmptyView body={s.deadlinesEmpty} />
      ) : (
        <View>
          {deadlines.map((d) => {
            const c = countdown(s, d.dueAt);
            return (
              <Card key={d.id}>
                <Badge tone={d.done ? "green" : c.tone}>{d.done ? s.approved : c.text}</Badge>
                <Text style={[type.cardTitle, styles.title]}>{d.title}</Text>
                {d.detail ? <Muted>{d.detail}</Muted> : null}
                <Muted>
                  {s.dueOn}: {formatDate(d.dueAt, language)}
                </Muted>
                {d.relatedApprovalId && !d.done ? (
                  <Pressable
                    onPress={() => router.push({ pathname: "/approvals/[id]", params: { id: d.relatedApprovalId ?? "" } })}
                    accessibilityRole="button"
                    style={styles.link}
                  >
                    <Text style={styles.linkText}>
                      {s.relatedApproval} · {s.viewApproval}
                    </Text>
                  </Pressable>
                ) : null}
              </Card>
            );
          })}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.text, marginTop: 8, marginBottom: 4 },
  link: { marginTop: 12, minHeight: 48, justifyContent: "center" },
  linkText: { color: colors.pen, fontSize: 16, fontWeight: "600" },
});
