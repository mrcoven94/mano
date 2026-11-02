// Language override. The default follows the device; this screen pins
// English or Spanish.

import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Screen, Title } from "../components/ui";
import { useAuth } from "../lib/auth";
import { useLanguage, useStrings } from "../lib/i18n";
import { syncReminders } from "../lib/notify";
import type { Language } from "../lib/strings";
import { colors, tapTarget, type } from "../lib/theme";

export default function LanguageScreen() {
  const s = useStrings();
  const { language, setLanguage } = useLanguage();
  const { client, session, generation, isCurrentGeneration } = useAuth();

  const pick = async (code: Language): Promise<void> => {
    await setLanguage(code);
    if (session) {
      const gen = generation;
      await syncReminders(code, client, session, () => isCurrentGeneration(gen)).catch(() => {});
    }
  };

  const options: { code: Language; label: string }[] = [
    { code: "en", label: s.english },
    { code: "es", label: s.spanish },
  ];

  return (
    <Screen>
      <Title>{s.languageTitle}</Title>
      <View style={styles.list}>
        {options.map((o) => (
          <Pressable
            key={o.code}
            onPress={() => void pick(o.code)}
            accessibilityRole="radio"
            accessibilityState={{ checked: language === o.code }}
            style={[styles.row, language === o.code && styles.active]}
          >
            <Text style={[type.body, styles.label]}>{o.label}</Text>
            {language === o.code ? <Ionicons name="checkmark-outline" size={22} color={colors.text} /> : null}
          </Pressable>
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { marginTop: 8 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: tapTarget,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    marginBottom: 8,
  },
  active: { borderColor: colors.text, borderWidth: 2 },
  label: { flex: 1, color: colors.text },
});
