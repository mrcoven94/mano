// The four tabs: agent, approvals, deadlines and more. The approvals
// tab carries the pending count; notification taps land here too.

import { useCallback, useState } from "react";
import { Text, type ColorValue } from "react-native";
import { Redirect, Tabs, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { tabLabel } from "../../lib/a11y-labels";
import { AuthError } from "../../lib/api/types";
import { useAuth } from "../../lib/auth";
import { useStrings } from "../../lib/i18n";
import { colors } from "../../lib/theme";

// Above this the labels stop growing, so four of them still fit across a
// phone. Reading a tab at a larger size is what the system's own large-text
// tools are for; body text keeps scaling without a limit.
const TAB_LABEL_MAX_SCALE = 1.3;

// A narrow phone at the largest size shrinks a long label instead of cutting it.
function TabLabel({ color, children }: { color: ColorValue; children: string }) {
  return (
    <Text
      numberOfLines={1}
      adjustsFontSizeToFit
      minimumFontScale={0.8}
      maxFontSizeMultiplier={TAB_LABEL_MAX_SCALE}
      style={{ color, fontSize: 12, fontWeight: "600", textAlign: "center" }}
    >
      {children}
    </Text>
  );
}

export default function TabsLayout() {
  const s = useStrings();
  const insets = useSafeAreaInsets();
  const { client, session, status, signOut } = useAuth();
  const [pending, setPending] = useState(0);

  useFocusEffect(
    useCallback(() => {
      if (!session) return;
      client
        .listApprovals(session)
        .then((all) => setPending(all.filter((a) => a.status === "pending").length))
        .catch((err: unknown) => {
          if (err instanceof AuthError) void signOut();
          else setPending(0);
        });
    }, [client, session, signOut]),
  );

  if (status === "signed-out") return <Redirect href="/(auth)/sign-in" />;
  if (status === "loading" || !session) return null;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.text,
        tabBarInactiveTintColor: colors.faint,
        // Room for the icon and a label at the largest size, above the home indicator.
        tabBarStyle: { height: 64 + insets.bottom },
        tabBarLabel: TabLabel,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: s.tabsAgent,
          tabBarAccessibilityLabel: tabLabel(s.tabsAgent),
          tabBarIcon: ({ color, size }) => <Ionicons name="chatbubble-ellipses-outline" color={typeof color === "string" ? color : colors.faint} size={size} />,
        }}
      />
      <Tabs.Screen
        name="approvals"
        options={{
          title: s.tabsApprovals,
          tabBarAccessibilityLabel: tabLabel(s.tabsApprovals, pending),
          tabBarBadge: pending > 0 ? pending : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.hl, color: colors.text },
          tabBarIcon: ({ color, size }) => <Ionicons name="checkmark-circle-outline" color={typeof color === "string" ? color : colors.faint} size={size} />,
        }}
      />
      <Tabs.Screen
        name="deadlines"
        options={{
          title: s.tabsDeadlines,
          tabBarAccessibilityLabel: tabLabel(s.tabsDeadlines),
          tabBarIcon: ({ color, size }) => <Ionicons name="calendar-outline" color={typeof color === "string" ? color : colors.faint} size={size} />,
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: s.tabsMore,
          tabBarAccessibilityLabel: tabLabel(s.tabsMore),
          tabBarIcon: ({ color, size }) => <Ionicons name="ellipsis-horizontal-circle-outline" color={typeof color === "string" ? color : colors.faint} size={size} />,
        }}
      />
    </Tabs>
  );
}
