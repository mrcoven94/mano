// Language override. The default follows the device; this screen pins
// English or Spanish.

import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Screen, Title } from "../components/ui";
import { useLanguage, useStrings } from "../lib/i18n";
import type { Language } from "../lib/strings";
import { colors, tapTarget, type } from "../lib/theme";

export default function LanguageScreen() {
  const s = useStrings();
  const { language, setLanguage } = useLanguage();

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
            onPress={() => void setLanguage(o.code)}
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
