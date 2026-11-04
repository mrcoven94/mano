// Shared interface pieces in the withmano.com look: paper cards, ink
// pill buttons, highlighter accents. Every touch target is at least
// 48px tall.

import { useEffect, useState, type ReactNode } from "react";
import { useRouter, type Href } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Platform,
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
import { useLanguage, useStrings } from "../lib/i18n";
import { LIVE_REGION_ARM_MS, announceOptions, announcesByCall, liveRegionProps } from "../lib/live-region";
import type { Language } from "../lib/strings";
import { colors, fonts, radius, tapTarget, type } from "../lib/theme";

// A pushed screen names its parent. With no history, as after a reload
// into a deep link on the web, going back opens the parent instead.
export function useGoBack(parent: Href): () => void {
  const router = useRouter();
  return () => (router.canGoBack() ? router.back() : router.replace(parent));
}

function BackBar({ parent }: { parent: Href }) {
  const s = useStrings();
  const goBack = useGoBack(parent);
  return (
    <View style={styles.backBar}>
      <Pressable
        onPress={goBack}
        accessibilityRole="button"
        accessibilityLabel={s.back}
        style={({ pressed }) => [styles.back, pressed && styles.pressed]}
      >
        <Ionicons name="chevron-back" size={22} color={colors.text} />
        <Text style={[type.body, styles.backText]}>{s.back}</Text>
      </Pressable>
    </View>
  );
}

export function Screen({
  children,
  scroll = true,
  style,
  back,
}: {
  children: ReactNode;
  scroll?: boolean;
  style?: StyleProp<ViewStyle>;
  back?: Href;
}) {
  const body = (
    <View style={[styles.screenInner, style]}>
      {children}
    </View>
  );
  return (
    <SafeAreaView style={styles.screen} edges={["top", "left", "right"]}>
      {back ? <BackBar parent={back} /> : null}
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
  return (
    <Text accessibilityRole="header" aria-level={1} style={[type.title, styles.title, style]}>
      {children}
    </Text>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <Text accessibilityRole="header" aria-level={2} style={[type.section, styles.sectionTitle]}>
      {children}
    </Text>
  );
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

// Shows its children only while message is set, and has a screen reader say
// message when it arrives. It is on screen first and fills in a moment later,
// so a message present from the first render is still announced. Keep buttons
// out of it: a spinner swapping in would read the message again.
export function LiveRegion({
  message,
  urgent = false,
  style,
  children,
}: {
  message: string | null;
  urgent?: boolean;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), LIVE_REGION_ARM_MS);
    return () => clearTimeout(timer);
  }, []);
  const shown = armed ? message : null;
  useEffect(() => {
    if (shown !== null && announcesByCall(Platform.OS)) {
      AccessibilityInfo.announceForAccessibilityWithOptions(shown, announceOptions(urgent));
    }
  }, [shown, urgent]);
  return (
    <View collapsable={false} style={style} {...liveRegionProps(urgent)}>
      {shown !== null ? children : null}
    </View>
  );
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
      accessibilityLabel={title}
      accessibilityState={{ disabled: disabled || busy }}
      aria-busy={busy}
      style={({ pressed }) => [styles.btn, (disabled || busy) && styles.btnDisabled, pressed && styles.pressed]}
    >
      {busy ? <ActivityIndicator color={colors.ink} /> : <Text style={styles.btnText}>{title}</Text>}
    </Pressable>
  );
}

export function GhostBtn({
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
      accessibilityLabel={title}
      accessibilityState={{ disabled: disabled || busy }}
      aria-busy={busy}
      style={({ pressed }) => [styles.btn, styles.ghost, (disabled || busy) && styles.btnDisabled, pressed && styles.pressed]}
    >
      {busy ? <ActivityIndicator color={colors.text} /> : <Text style={styles.ghostText}>{title}</Text>}
    </Pressable>
  );
}

// A third, quieter action beside Btn and GhostBtn: plain underlined
// text, still a full 48px target.
export function LinkBtn({ title, onPress, disabled = false }: { title: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [styles.link, disabled && styles.btnDisabled, pressed && styles.pressed]}
    >
      <Text style={styles.linkText}>{title}</Text>
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

// English or Spanish before there is an account: sign-in has to be readable
// first. The same saved choice the Language screen sets. Each name is
// written in its own language, so it is findable from either one.
export function LanguageSwitch() {
  const s = useStrings();
  const { language, setLanguage } = useLanguage();
  const options: { code: Language; label: string }[] = [
    { code: "en", label: s.english },
    { code: "es", label: s.spanish },
  ];
  return (
    <View style={styles.languages} accessibilityRole="radiogroup" accessibilityLabel={s.languageTitle}>
      {options.map((o) => {
        const active = language === o.code;
        return (
          <Pressable
            key={o.code}
            onPress={() => void setLanguage(o.code).catch(() => undefined)}
            accessibilityRole="radio"
            accessibilityLabel={o.label}
            accessibilityState={{ checked: active }}
            aria-checked={active}
            style={({ pressed }) => [styles.languageOption, pressed && styles.pressed]}
          >
            <Text style={active ? styles.languageActive : styles.languageOther}>{o.label}</Text>
          </Pressable>
        );
      })}
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
      <LiveRegion urgent message={`${title}. ${body}`}>
        <Text style={[type.cardTitle, styles.errorTitle]}>{title}</Text>
        <Text style={[type.small, styles.muted, styles.errorBody]}>{body}</Text>
      </LiveRegion>
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
  backBar: { width: "100%", maxWidth: 640, alignSelf: "center", paddingHorizontal: 12, paddingTop: 4 },
  back: { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", minHeight: tapTarget, paddingHorizontal: 8, gap: 2 },
  backText: { color: colors.text, fontFamily: fonts.sansMedium },
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
  link: { minHeight: tapTarget, paddingHorizontal: 12, alignItems: "center", justifyContent: "center" },
  linkText: { color: colors.pen, fontSize: 16, fontWeight: "500", textDecorationLine: "underline" },
  fieldWrap: { marginBottom: 16 },
  fieldLabel: { fontSize: 14, fontWeight: "600", color: colors.text, marginBottom: 8 },
  field: {
    minHeight: tapTarget,
    borderWidth: 1,
    borderColor: colors.fieldBorder,
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
  badgeText: { fontSize: 14, lineHeight: 20, fontWeight: "600", color: colors.text },
  languages: { flexDirection: "row", justifyContent: "flex-end", marginTop: -12, marginRight: -10, marginBottom: 4 },
  languageOption: { minHeight: tapTarget, minWidth: tapTarget, paddingHorizontal: 10, alignItems: "center", justifyContent: "center" },
  languageActive: { fontSize: 15, fontWeight: "600", color: colors.text },
  languageOther: { fontSize: 15, fontWeight: "500", color: colors.pen, textDecorationLine: "underline" },
  demo: { backgroundColor: colors.hl, borderRadius: radius.sm, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 16 },
  demoText: { fontSize: 13, fontWeight: "600", color: colors.text },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  errorTitle: { color: colors.text, marginBottom: 8, textAlign: "center" },
  errorBody: { textAlign: "center", marginBottom: 16 },
});
