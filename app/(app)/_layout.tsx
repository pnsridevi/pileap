/**
 * app/(app)/_layout.tsx
 *
 * [CHANGE — temporary, per testing request] Report Card, Modules, and
 * Goals tabs are hidden from the tab bar for now via `options.href: null`.
 * This is the correct Expo Router way to hide a tab: commenting out the
 * <Tabs.Screen> entry does NOT work, because the tab bar is generated
 * from every file present in app/(app)/ regardless of what's declared
 * here — the entry only customizes icon/title/order IF the route shows.
 * `href: null` explicitly excludes it from the tab bar while keeping the
 * route and screen fully intact (so any internal links to it still work).
 * To restore these tabs later, just remove the `href: null` line from
 * each entry below.
 */
import { Tabs } from 'expo-router';
import { colors } from '@/constants/theme';
import Svg, { Path, Polyline, Line, Circle } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

function ReportCardIcon({ color }: { color: string }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2}>
      <Path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <Polyline points="14 2 14 8 20 8" />
    </Svg>
  );
}

function ModulesIcon({ color }: { color: string }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2}>
      <Path d="M12 20V10" />
      <Path d="M18 20V4" />
      <Path d="M6 20v-4" />
    </Svg>
  );
}

function TransactionsIcon({ color }: { color: string }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2}>
      <Line x1="8" y1="6" x2="21" y2="6" />
      <Line x1="8" y1="12" x2="21" y2="12" />
      <Line x1="8" y1="18" x2="21" y2="18" />
      <Line x1="3" y1="6" x2="3.01" y2="6" />
      <Line x1="3" y1="12" x2="3.01" y2="12" />
      <Line x1="3" y1="18" x2="3.01" y2="18" />
    </Svg>
  );
}

function GoalsIcon({ color }: { color: string }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2}>
      <Circle cx={12} cy={12} r={10} />
      <Circle cx={12} cy={12} r={6} />
      <Circle cx={12} cy={12} r={2} />
    </Svg>
  );
}

function ProfileIcon({ color }: { color: string }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2}>
      <Path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <Circle cx={12} cy={7} r={4} />
    </Svg>
  );
}

// [ADD] Simple flask/test icon — no existing icon in this file fit "test
// harness," so a minimal new one, matching the same 22x22/stroke-only
// style as the others above.
function TestSmsIcon({ color }: { color: string }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2}>
      <Path d="M9 2v6L4 20a1 1 0 0 0 1 2h14a1 1 0 0 0 1-2L15 8V2" />
      <Line x1="9" y1="2" x2="15" y2="2" />
      <Line x1="7" y1="15" x2="17" y2="15" />
    </Svg>
  );
}

export default function AppLayout() {
  const insets = useSafeAreaInsets();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.brand,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: {
          borderTopWidth: 1,
          borderTopColor: colors.border,
          backgroundColor: colors.white,
          height: 60 + insets.bottom,
          paddingBottom: insets.bottom + 8,
          paddingTop: 6,
        },
        tabBarLabelStyle: {
          fontSize: 10,
          fontWeight: '500',
        },
      }}
    >
      {/* [ADD] Test SMS tab — temporary, for easy access during testing.
          [ORDER — per request] Test SMS first, then Transactions, then
          Profile. Report Card / Modules / Goals are hidden below via
          href: null but remain first in file order per original file. */}
      <Tabs.Screen
        name="test-sms"
        options={{
          title: 'Test SMS',
          tabBarIcon: ({ color }) => <TestSmsIcon color={color} />,
        }}
      />
      {/* [HIDDEN — temporary, testing request] href: null removes this
          from the tab bar while keeping the route/screen fully working.
          Remove the href line to restore it to the tab bar. */}
      <Tabs.Screen
        name="report-card"
        options={{
          href: null,
          title: 'Report Card',
          tabBarIcon: ({ color }) => <ReportCardIcon color={color} />,
        }}
      />
      <Tabs.Screen
        name="modules"
        options={{
          href: null,
          title: 'Modules',
          tabBarIcon: ({ color }) => <ModulesIcon color={color} />,
        }}
      />
      <Tabs.Screen
        name="transactions"
        options={{
          title: 'Transactions',
          tabBarIcon: ({ color }) => <TransactionsIcon color={color} />,
        }}
      />
      <Tabs.Screen
        name="goals"
        options={{
          href: null,
          title: 'Goals',
          tabBarIcon: ({ color }) => <GoalsIcon color={color} />,
        }}
      />
      {/* [KEPT — per request] Profile has the sign-out option, needed
          during testing even though other tabs are hidden. */}
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color }) => <ProfileIcon color={color} />,
        }}
      />
    </Tabs>
  );
}