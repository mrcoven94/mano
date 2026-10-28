// App entry: loads the withmano.com typefaces, mounts the language and
// session providers, and routes notification taps to the right screen.

import { useEffect } from "react";
import { Stack, useRouter } from "expo-router";
import { Geist_400Regular, Geist_500Medium, Geist_700Bold, useFonts as useGeist } from "@expo-google-fonts/geist";
import {
  SchibstedGrotesk_500Medium,
  SchibstedGrotesk_700Bold,
  useFonts as useDisplay,
} from "@expo-google-fonts/schibsted-grotesk";
import * as Notifications from "expo-notifications";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { AuthProvider } from "../lib/auth";
import { easProjectId } from "../lib/config";
import { LanguageProvider } from "../lib/i18n";
import { ensureNotificationSetup } from "../lib/notify";

void SplashScreen.preventAutoHideAsync();

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
  const ready = geistLoaded && displayLoaded;

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null;

  return (
    <LanguageProvider>
      <AuthProvider>
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
