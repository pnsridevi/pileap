import { useEffect } from 'react';
import { Stack, router } from 'expo-router';
import { View, ActivityIndicator } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';
import * as Updates from 'expo-updates';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/store/authStore';
import { colors } from '@/constants/theme';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const { isLoading, isLoggedIn, setSession } = useAuthStore();

  // [FIX] Original version used Updates.addListener()/UpdateEventType,
  // which no longer exist on this SDK — expo-updates moved to a
  // state-machine-based API (useUpdates() hook) instead. Confirmed the
  // correct field names directly from this app's own native logs seen
  // earlier this session (Kotlin logcat showed exactly this shape:
  // isUpdateAvailable, isUpdatePending, isChecking, isDownloading,
  // isRestarting, downloadProgress), not guessed from memory alone.
  //
  // isUpdatePending flips true once a background-checked update has
  // finished downloading and is ready to apply — the same "ready to
  // switch over" moment the old addListener('UPDATE_AVAILABLE') version
  // was meant to catch. See the effect below for why this exists at all.
  const { isUpdatePending } = Updates.useUpdates();

  // [ADD] Fixes the "install/open shows old screen, close+reopen shows
  // new one" behavior — root cause: app.json's fallbackToCacheTimeout: 0
  // means EVERY launch renders the already-cached/embedded bundle
  // immediately, while expo-updates checks for a newer one in the
  // background. That's correct for fast startup, but nothing previously
  // told the already-rendered app to switch once that background check
  // finished — the user had to manually close and reopen to see it,
  // discovered repeatedly this session with test builds/updates.
  //
  // This reloads automatically the moment isUpdatePending turns true —
  // so the fix applies itself on the SAME launch, typically a few
  // seconds after the app opens, rather than requiring a second manual
  // open. No visible interruption for the common case (nothing's usually
  // mid-interaction that early in a cold launch); if an update is quite
  // large or the network is slow, the reload could land after the user
  // has started navigating — acceptable for now given how much worse the
  // "silently stale" behavior was, but worth revisiting with a toast/
  // confirmation UI if that turns out to feel jarring in practice.
  useEffect(() => {
    if (isUpdatePending) {
      Updates.reloadAsync().catch((e) => {
        console.error('Auto-reload after update download failed:', e);
      });
    }
  }, [isUpdatePending]);

  useEffect(() => {
    supabase.auth.getSession()
      .then(({ data: { session } }) => {
        setSession(session);
      })
      .catch(() => {
        setSession(null);
      })
      .finally(() => {
        SplashScreen.hideAsync();
      });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (isLoading) return;
    // [CHANGE — temporary, per testing request] Landing tab changed from
    // Report Card to Transactions, since Report Card/Modules/Goals are
    // hidden from the tab bar for now (see app/(app)/_layout.tsx).
    router.replace(isLoggedIn ? '/(app)/transactions' : '/(auth)/sign-in');
  }, [isLoading, isLoggedIn]);

  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.white }}>
        <ActivityIndicator size="large" color={colors.brand} />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(auth)" options={{ headerShown: false }} />
      <Stack.Screen name="(app)" options={{ headerShown: false }} />
      <Stack.Screen name="onboarding" options={{ headerShown: false }} />
    </Stack>
  );
}