import { View, Text, TouchableOpacity, StyleSheet, SafeAreaView } from 'react-native';
import { router } from 'expo-router';
import { useAuthStore } from '@/store/authStore';
import { colors, spacing, fontSize, fontWeight, radius, shadows } from '@/constants/theme';

export default function SignInScreen() {

  const { setSession } = useAuthStore();

  function handleSignIn() {
    // DEV MODE: bypass Supabase entirely
    // Just set a fake session and go straight to the app
    setSession({
      user: {
        id: 'dev-user-001',
        email: 'sri.cheeku@gmail.com',
        phone: '+919962137433',
        app_metadata: {},
        user_metadata: {},
        aud: 'authenticated',
        created_at: new Date().toISOString(),
      },
      access_token: 'dev-token',
      refresh_token: 'dev-refresh',
      expires_in: 99999,
      expires_at: 99999,
      token_type: 'bearer',
    } as any);
    router.replace('/(app)/report-card');
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>

        <View style={styles.logoRow}>
          <View style={styles.logoIcon}>
            <Text style={styles.logoIconText}>P</Text>
          </View>
          <Text style={styles.logoText}>Pileap</Text>
        </View>

        <View style={styles.headingBlock}>
          <Text style={styles.heading}>Your financial health,{'\n'}tracked every month.</Text>
          <Text style={styles.sub}>Sign in to continue.</Text>
        </View>

        <View style={styles.devBadge}>
          <Text style={styles.devBadgeText}>DEV MODE — no Supabase needed</Text>
        </View>

        <TouchableOpacity
          style={styles.btn}
          onPress={handleSignIn}
          activeOpacity={0.85}
        >
          <Text style={styles.btnText}>Sign in</Text>
        </TouchableOpacity>

      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:         { flex: 1, backgroundColor: colors.white },
  container:    { flex: 1, paddingHorizontal: spacing.lg, justifyContent: 'center', gap: spacing.lg },
  logoRow:      { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  logoIcon:     { width: 40, height: 40, borderRadius: radius.lg, backgroundColor: colors.brand, alignItems: 'center', justifyContent: 'center', ...shadows.md },
  logoIconText: { color: colors.white, fontSize: fontSize.lg, fontWeight: fontWeight.bold },
  logoText:     { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: colors.dark, letterSpacing: -0.5 },
  headingBlock: { gap: spacing.xs },
  heading:      { fontSize: fontSize.xxl, fontWeight: fontWeight.extrabold, color: colors.dark, letterSpacing: -0.8, lineHeight: 32 },
  sub:          { fontSize: fontSize.md, color: colors.muted, marginTop: spacing.xs },
  devBadge:     { backgroundColor: colors.amberLight, borderRadius: radius.md, paddingVertical: spacing.sm, paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.amber },
  devBadgeText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: colors.amber },
  btn:          { backgroundColor: colors.brand, paddingVertical: 14, borderRadius: radius.lg, alignItems: 'center', ...shadows.md },
  btnText:      { color: colors.white, fontSize: fontSize.md, fontWeight: fontWeight.semibold },
});