/**
 * app/(app)/profile/index.tsx
 *
 * [ADD — this pass] "Accounts" nav row, linking to the newly-relocated
 * app/(app)/profile/accounts.tsx (moved from transactions/accounts.tsx).
 * Everything else in this file — identity header, sign-out flow — is
 * unchanged from the original.
 */
import { useState } from 'react';
import { View, Text, StyleSheet, SafeAreaView, Alert, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import Svg, { Path, Circle, Polyline } from 'react-native-svg';
import { colors, spacing, fontSize, fontWeight, radius, shadows } from '@/constants/theme';
import { Button } from '@/components/ui/Button';
import { signOut } from '@/lib/auth';
import { useAuthStore } from '@/store/authStore';

function AccountsIcon() {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={colors.brand} strokeWidth={2}>
      <Path d="M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z" />
      <Path d="M2 10h20" />
    </Svg>
  );
}

function ChevronRightIcon() {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={colors.muted} strokeWidth={2}>
      <Polyline points="9 18 15 12 9 6" />
    </Svg>
  );
}

export default function ProfileScreen() {
  const router = useRouter();
  const { user } = useAuthStore();
  const [signingOut, setSigningOut] = useState(false);

  const handleSignOutPress = () => {
    Alert.alert(
      'Sign out?',
      'You\'ll need to verify your phone number again to sign back in.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign out',
          style: 'destructive',
          onPress: async () => {
            setSigningOut(true);
            try {
              await signOut();
              router.replace('/(auth)/sign-in');
            } catch (e) {
              setSigningOut(false);
              Alert.alert('Error', e instanceof Error ? e.message : String(e));
            }
          },
        },
      ],
    );
  };

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.container}>
        <View style={s.header}>
          <Text style={s.eyebrow}>PROFILE</Text>
          <View style={s.avatar}>
            <Text style={s.avatarText}>
              {(user?.phone ?? user?.email ?? '?').slice(-2)}
            </Text>
          </View>
          <Text style={s.identity}>{user?.phone ?? user?.email ?? 'Signed in'}</Text>
        </View>

        <View style={s.card}>
          <Text style={s.cardLabel}>Account</Text>
          <Text style={s.cardValue}>{user?.phone ?? '—'}</Text>
        </View>

        {/* [ADD] Accounts nav row — relocated from the Transactions tab */}
        <TouchableOpacity style={s.navRow} onPress={() => router.push('/profile/accounts')} activeOpacity={0.7}>
          <View style={s.navRowLeft}>
            <AccountsIcon />
            <View>
              <Text style={s.navRowTitle}>Accounts</Text>
              <Text style={s.navRowSub}>Manage which accounts are tracked</Text>
            </View>
          </View>
          <ChevronRightIcon />
        </TouchableOpacity>

        <Button
          label="Sign Out"
          variant="danger"
          loading={signingOut}
          onPress={handleSignOutPress}
        />
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe:      { flex: 1, backgroundColor: colors.surface },
  container: { flex: 1, padding: spacing.lg, gap: spacing.lg },
  header:    { alignItems: 'center', gap: spacing.sm, marginTop: spacing.lg },
  eyebrow:   { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.brand, letterSpacing: 1 },
  avatar: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: colors.brand, alignItems: 'center', justifyContent: 'center',
    ...shadows.md,
  },
  avatarText: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.white },
  identity:  { fontSize: fontSize.lg, fontWeight: fontWeight.semibold, color: colors.dark },
  card: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  cardLabel: {
    fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: colors.muted,
    textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: spacing.xs,
  },
  cardValue: { fontSize: fontSize.base, color: colors.dark, fontWeight: fontWeight.medium },

  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  navRowLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  navRowTitle: { fontSize: fontSize.base, fontWeight: fontWeight.semibold, color: colors.dark },
  navRowSub: { fontSize: fontSize.xs, color: colors.muted, marginTop: 1 },
});