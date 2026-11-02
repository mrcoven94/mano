// Shared interface pieces in the withmano.com look: paper cards, ink
// pill buttons, highlighter accents. Every touch target is at least
// 48px tall.

import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors, radius, tapTarget, type } from "../lib/theme";

export function Screen({
  children,
  scroll = true,
  style,
}: {
  children: ReactNode;
  scroll?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const body = (
    <View style={[styles.screenInner, style]}>
      {children}
    </View>
  );
  return (
    <SafeAreaView style={styles.screen} edges={["top", "left", "right"]}>
      {scroll ? (
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          {body}
        </ScrollView>
      ) : (
        body
      )}
    </SafeAreaView>
  );
}

export function Title({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[type.title, styles.title, style]}>{children}</Text>;
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <Text style={[type.section, styles.sectionTitle]}>{children}</Text>;
}

export function Body({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[type.body, styles.body, style]}>{children}</Text>;
}

export function Muted({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[type.small, styles.muted, style]}>{children}</Text>;
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Btn({
  title,
  onPress,
  disabled = false,
  busy = false,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      style={({ pressed }) => [styles.btn, (disabled || busy) && styles.btnDisabled, pressed && styles.pressed]}
    >
      {busy ? <ActivityIndicator color={colors.ink} /> : <Text style={styles.btnText}>{title}</Text>}
    </Pressable>
  );
}

export function GhostBtn({ title, onPress }: { title: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.btn, styles.ghost, pressed && styles.pressed]}
    >
      <Text style={styles.ghostText}>{title}</Text>
    </Pressable>
  );
}

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType = "default",
  autoCapitalize = "none",
  maxLength,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  keyboardType?: "default" | "email-address" | "number-pad";
  autoCapitalize?: "none" | "sentences";
  maxLength?: number;
}) {
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.faint}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        maxLength={maxLength}
        style={styles.field}
        accessibilityLabel={label}
      />
    </View>
  );
}

export function Badge({ tone, children }: { tone: "hl" | "alert" | "green" | "blue"; children: ReactNode }) {
  return (
    <View style={[styles.badge, tone === "hl" && styles.badgeHl, tone === "alert" && styles.badgeAlert, tone === "green" && styles.badgeGreen, tone === "blue" && styles.badgeBlue]}>
      <Text style={styles.badgeText}>{children}</Text>
    </View>
  );
}

export function DemoBanner({ text }: { text: string }) {
  return (
    <View style={styles.demo} accessibilityRole="text">
      <Text style={styles.demoText}>{text}</Text>
    </View>
  );
}

export function LoadingView() {
  return (
    <View style={styles.center}>
      <ActivityIndicator size="large" color={colors.text} />
    </View>
  );
}

export function ErrorView({ title, body, retry, retryTitle }: { title: string; body: string; retry: () => void; retryTitle: string }) {
  return (
    <View style={styles.center}>
      <Text style={[type.cardTitle, styles.errorTitle]}>{title}</Text>
      <Text style={[type.small, styles.muted, styles.errorBody]}>{body}</Text>
      <GhostBtn title={retryTitle} onPress={retry} />
    </View>
  );
}

export function EmptyView({ body }: { body: string }) {
  return (
    <Card>
      <Text style={[type.body, styles.body]}>{body}</Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  scroll: { flexGrow: 1 },
  screenInner: { flex: 1, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 32, width: "100%", maxWidth: 640, alignSelf: "center" },
  title: { color: colors.text, marginBottom: 8 },
  sectionTitle: { color: colors.text, marginTop: 24, marginBottom: 12 },
  body: { color: colors.text },
  muted: { color: colors.muted },
  card: { backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: radius.md, padding: 16, marginBottom: 12 },
  btn: {
    minHeight: tapTarget,
    paddingHorizontal: 22,
    borderRadius: radius.pill,
    backgroundColor: colors.text,
    alignItems: "center",
    justifyContent: "center",
  },
  btnDisabled: { opacity: 0.5 },
  pressed: { opacity: 0.85 },
  btnText: { color: colors.ink, fontSize: 16, fontWeight: "600" },
  ghost: { backgroundColor: colors.bg2 },
  ghostText: { color: colors.text, fontSize: 16, fontWeight: "500" },
  fieldWrap: { marginBottom: 16 },
  fieldLabel: { fontSize: 14, fontWeight: "600", color: colors.text, marginBottom: 8 },
  field: {
    minHeight: tapTarget,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.sm,
    paddingHorizontal: 14,
    fontSize: 16,
    color: colors.text,
    backgroundColor: colors.bg,
  },
  badge: { alignSelf: "flex-start", borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4, backgroundColor: colors.bg3 },
  badgeHl: { backgroundColor: colors.hl },
  badgeAlert: { backgroundColor: colors.alertSoft },
  badgeGreen: { backgroundColor: colors.greenSoft },
  badgeBlue: { backgroundColor: colors.penSoft },
  badgeText: { fontSize: 12, fontWeight: "600", color: colors.text },
  demo: { backgroundColor: colors.hl, borderRadius: radius.sm, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 16 },
  demoText: { fontSize: 13, fontWeight: "600", color: colors.text },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  errorTitle: { color: colors.text, marginBottom: 8, textAlign: "center" },
  errorBody: { textAlign: "center", marginBottom: 16 },
});
