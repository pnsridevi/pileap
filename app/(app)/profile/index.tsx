/**
 * app/(app)/profile/index.tsx
 *
 * Profile screen — was a stub (title text literally said "Settings ·
 * Data source · Sign out" as a placeholder label, nothing functional
 * behind it). Confirmed via direct file paste this session — no real
 * content existed to preserve, unlike the accounts.tsx situation earlier.
 *
 * Shows the signed-in user's phone number (from authStore's session) and
 * a working Sign Out button.
 *
 * Sign-out flow: signOut() (src/lib/auth.ts, already existed before this
 * session) calls supabase.auth.signOut() and clears authStore's session/
 * user/isLoggedIn. Root app/_layout.tsx already has a useEffect watching
 * isLoggedIn that redirects to '/(auth)/sign-in' whenever it goes false —
 * so the redirect happens automatically. The explicit router.replace()
 * below is redundant with that but harmless (navigating to an already-
 * targeted route is a no-op) — kept for immediate, predictable feedback
 * rather than relying solely on a store-subscription side effect timing.
 */
import { useState } from 'react';
import { View, Text, StyleSheet, SafeAreaView, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { colors, spacing, fontSize, fontWeight, radius, shadows } from '@/constants/theme';
import { Button } from '@/components/ui/Button';
import { signOut } from '@/lib/auth';
import { useAuthStore } from '@/store/authStore';

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

        {/* [NOTE] Settings / Data source were part of the original
            placeholder title but aren't built yet — this screen currently
            covers identity + sign-out only. */}

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
});