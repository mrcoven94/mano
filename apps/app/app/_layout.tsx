// App entry: loads the withmano.com typefaces, resolves the engine
// (failing loudly at start when neither an engine URL nor the demo
// flag is set), mounts the language and session providers, guards
// every route on the session, and routes notification taps to the
// right screen.

import { useEffect, useMemo } from "react";
import { Stack, useRouter, useSegments } from "expo-router";
import { Geist_400Regular, Geist_500Medium, Geist_700Bold, useFonts as useGeist } from "@expo-google-fonts/geist";
import {
  SchibstedGrotesk_500Medium,
  SchibstedGrotesk_700Bold,
  useFonts as useDisplay,
} from "@expo-google-fonts/schibsted-grotesk";
import * as Notifications from "expo-notifications";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { Body, Title } from "../components/ui";
import { AuthProvider, useAuth } from "../lib/auth";
import { resolveClient, type ResolvedClient } from "../lib/client";
import { easProjectId } from "../lib/config";
import { LanguageProvider, useStrings } from "../lib/i18n";
import { ensureNotificationSetup } from "../lib/notify";
import { sessionRouteGuard } from "../lib/route-guard";

void SplashScreen.preventAutoHideAsync();

function useResolvedClient(): { resolved: ResolvedClient | null; fatal: boolean } {
  return useMemo(() => {
    try {
      return { resolved: resolveClient(), fatal: false };
    } catch {
      return { resolved: null, fatal: true };
    }
  }, []);
}

function FatalConfig() {
  const s = useStrings();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#FFFFFF", padding: 24, justifyContent: "center" }}>
      <Title>{s.configErrorTitle}</Title>
      <Body>{s.configErrorBody}</Body>
    </SafeAreaView>
  );
}

function SessionGate() {
  const { status } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  useEffect(() => {
    // Dismissing drops every detail screen from the stack; the replace
    // then lands on sign-in even when the app booted straight into a
    // deep link with nothing to dismiss.
    if (sessionRouteGuard(status, segments[0]) === "sign-in") {
      router.dismissAll();
      router.replace("/(auth)/sign-in");
    }
  }, [status, segments, router]);
  return null;
}

function NotificationsGate() {
  const router = useRouter();
  useEffect(() => {
    ensureNotificationSetup(easProjectId()).catch(() => {});
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const kind = response.notification.request.content.data?.kind;
      if (kind === "deadline") router.push("/(tabs)/deadlines");
      else router.push("/(tabs)/approvals");
    });
    return () => sub.remove();
  }, [router]);
  return null;
}

export default function RootLayout() {
  const [geistLoaded] = useGeist({ Geist_400Regular, Geist_500Medium, Geist_700Bold });
  const [displayLoaded] = useDisplay({ SchibstedGrotesk_500Medium, SchibstedGrotesk_700Bold });
  const clientState = useResolvedClient();
  const ready = geistLoaded && displayLoaded;

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null;

  if (!clientState.resolved) {
    return (
      <LanguageProvider>
        <StatusBar style="dark" />
        <FatalConfig />
      </LanguageProvider>
    );
  }

  return (
    <LanguageProvider>
      <AuthProvider initial={clientState.resolved}>
        <SessionGate />
        <NotificationsGate />
        <StatusBar style="dark" />
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="(auth)" />
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="approvals/[id]" options={{ presentation: "card" }} />
          <Stack.Screen name="documents" />
          <Stack.Screen name="documents/[id]" />
          <Stack.Screen name="access" />
          <Stack.Screen name="language" />
          <Stack.Screen name="about" />
        </Stack>
      </AuthProvider>
    </LanguageProvider>
  );
}
