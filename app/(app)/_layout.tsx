/**
 * app/(app)/_layout.tsx
 *
 * [CHANGE — this pass] "Test SMS" tab renamed to "Sync", pointing at the
 * new app/(app)/sync.tsx (replaces test-sms.tsx — delete that file after
 * this lands). Icon swapped for a refresh-style icon matching the new
 * purpose; the flask icon is gone since this is no longer a test screen.
 *
 * [ADD — this pass] Automatic sync wiring:
 *   - useEffect below calls syncRecentSmsMessages() once on mount, i.e.
 *     on every app open — this is the "guaranteed freshness when the
 *     user has the app open" half of automatic sync (see smsSync.ts's
 *     docblock).
 *   - registerBackgroundSyncAsync() registers the hourly background task
 *     (see backgroundSync.ts for what it does and its honest limits on
 *     Android). Registration itself is idempotent and safe to call on
 *     every launch.
 *   - Both are fire-and-forget here — a failure (not signed in yet,
 *     permission not granted, transient network error) must not block
 *     the tab bar from rendering. Errors are swallowed with a console
 *     warning; syncRecentSmsMessages() itself already no-ops cleanly if
 *     there's no signed-in user.
 *
 * [ADD — Oct 28] On-resume sync. The mount effect only runs on a cold
 * start — switching back to Pileap from recent apps did NOT sync, because
 * this layout stays mounted. A second effect now syncs whenever the app
 * returns to the foreground, at most once every RESUME_SYNC_MIN_GAP_MS so
 * quick app switches don't re-read SMS each time. smsSync.ts's lock
 * already prevents two syncs overlapping.
 *
 * Note: backgroundSync.ts is now also imported from apps/mobile/index.js
 * so the task is defined on background starts. Importing it here too is
 * harmless (a module only runs once).
 *
 * [KEPT] The href: null pattern for hiding Report Card/Modules/Goals
 * tabs, and the ordering comments below, are unchanged from before.
 */
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { Tabs } from 'expo-router';
import { colors } from '@/constants/theme';
import Svg, { Path, Polyline, Line, Circle } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { syncRecentSmsMessages } from '@/lib/services/smsSync';
import { registerBackgroundSyncAsync } from '@/lib/services/backgroundSync';

const RESUME_SYNC_MIN_GAP_MS = 5 * 60 * 1000; // 5 minutes

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

// [REPLACED] TestSmsIcon -> SyncIcon — simple refresh/circular-arrows
// glyph, matching the same 22x22/stroke-only style as the others above.
function SyncIcon({ color }: { color: string }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2}>
      <Polyline points="23 4 23 10 17 10" />
      <Polyline points="1 20 1 14 7 14" />
      <Path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </Svg>
  );
}

export default function AppLayout() {
  const insets = useSafeAreaInsets();
  // Time of the last sync this layout started (cold start or resume).
  const lastForegroundSyncAt = useRef(0);

  // [ADD] On-app-open sync + background-task registration. Runs once per
  // app mount (cold start), deliberately not tied to any tab being visible.
  useEffect(() => {
    lastForegroundSyncAt.current = Date.now();
    syncRecentSmsMessages().catch((e) => {
      console.warn('On-open SMS sync failed:', e instanceof Error ? e.message : e);
    });
    registerBackgroundSyncAsync().catch((e) => {
      console.warn('Background sync registration failed:', e instanceof Error ? e.message : e);
    });
  }, []);

  // [ADD — Oct 28] On-resume sync: runs when the app comes back to the
  // foreground (e.g. from recent apps), throttled to once per 5 minutes.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      if (Date.now() - lastForegroundSyncAt.current < RESUME_SYNC_MIN_GAP_MS) return;
      lastForegroundSyncAt.current = Date.now();
      syncRecentSmsMessages().catch((e) => {
        console.warn('On-resume SMS sync failed:', e instanceof Error ? e.message : e);
      });
    });
    return () => sub.remove();
  }, []);

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
      {/* [RENAMED] test-sms -> sync. Route file is now app/(app)/sync.tsx. */}
      <Tabs.Screen
        name="sync"
        options={{
          title: 'Sync',
          tabBarIcon: ({ color }) => <SyncIcon color={color} />,
        }}
      />
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