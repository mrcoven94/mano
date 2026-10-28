// The four tabs: agent, approvals, deadlines and more. The approvals
// tab carries the pending count; notification taps land here too.

import { useCallback, useState } from "react";
import { Tabs, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../lib/auth";
import { useStrings } from "../../lib/i18n";
import { colors } from "../../lib/theme";

export default function TabsLayout() {
  const s = useStrings();
  const { client, session } = useAuth();
  const [pending, setPending] = useState(0);

  useFocusEffect(
    useCallback(() => {
      if (!session) return;
      client
        .listApprovals(session)
        .then((all) => setPending(all.filter((a) => a.status === "pending").length))
        .catch(() => setPending(0));
    }, [client, session]),
  );

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.text,
        tabBarInactiveTintColor: colors.faint,
        tabBarStyle: { minHeight: 64 },
        tabBarLabelStyle: { fontSize: 12, fontWeight: "600" },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: s.tabsAgent,
          tabBarIcon: ({ color, size }) => <Ionicons name="chatbubble-ellipses-outline" color={typeof color === "string" ? color : colors.faint} size={size} />,
        }}
      />
      <Tabs.Screen
        name="approvals"
        options={{
          title: s.tabsApprovals,
          tabBarBadge: pending > 0 ? pending : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.hl, color: colors.text },
          tabBarIcon: ({ color, size }) => <Ionicons name="checkmark-circle-outline" color={typeof color === "string" ? color : colors.faint} size={size} />,
        }}
      />
      <Tabs.Screen
        name="deadlines"
        options={{
          title: s.tabsDeadlines,
          tabBarIcon: ({ color, size }) => <Ionicons name="calendar-outline" color={typeof color === "string" ? color : colors.faint} size={size} />,
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: s.tabsMore,
          tabBarIcon: ({ color, size }) => <Ionicons name="ellipsis-horizontal-circle-outline" color={typeof color === "string" ? color : colors.faint} size={size} />,
        }}
      />
    </Tabs>
  );
}
