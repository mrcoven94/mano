// The More tab: documents, access, language, about and sign-out.

import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { DemoBanner, Muted, Screen, SectionTitle, Title } from "../../components/ui";
import { useAuth } from "../../lib/auth";
import { useStrings } from "../../lib/i18n";
import { colors, tapTarget, type } from "../../lib/theme";

export default function More() {
  const s = useStrings();
  const router = useRouter();
  const { session, mode, signOut } = useAuth();

  const rows: { label: string; icon: "document-text-outline" | "people-outline" | "language-outline" | "information-circle-outline"; href: "/documents" | "/access" | "/language" | "/about" }[] = [
    { label: s.moreDocuments, icon: "document-text-outline", href: "/documents" },
    { label: s.moreAccess, icon: "people-outline", href: "/access" },
    { label: s.moreLanguage, icon: "language-outline", href: "/language" },
    { label: s.moreAbout, icon: "information-circle-outline", href: "/about" },
  ];

  return (
    <Screen>
      <Title>{s.tabsMore}</Title>
      {mode === "stand-in" ? <DemoBanner text={s.demoMode} /> : null}
      <View>
        {rows.map((row) => (
          <Pressable key={row.href} onPress={() => router.push(row.href)} accessibilityRole="button" style={styles.row}>
            <Ionicons name={row.icon} size={22} color={colors.text} />
            <Text style={[type.body, styles.label]}>{row.label}</Text>
            <Ionicons name="chevron-forward-outline" size={20} color={colors.faint} />
          </Pressable>
        ))}
      </View>
      <SectionTitle>{s.moreAccount}</SectionTitle>
      {session?.email ? <Muted>{session.email}</Muted> : null}
      <Pressable
        onPress={() => {
          void signOut().then(() => router.replace("/(auth)/sign-in"));
        }}
        accessibilityRole="button"
        style={[styles.row, styles.signOut]}
      >
        <Ionicons name="log-out-outline" size={22} color={colors.alert} />
        <Text style={[type.body, styles.signOutText]}>{s.signOut}</Text>
      </Pressable>
    </Screen>
  );
}

const styles = StyleSheet.create({
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
    marginBottom: 8,
  },
  label: { flex: 1, color: colors.text },
  signOut: { marginTop: 8 },
  signOutText: { flex: 1, color: colors.alert, fontWeight: "600" },
});
