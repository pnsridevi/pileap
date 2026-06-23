import { useEffect } from 'react';
import { Stack, router } from 'expo-router';
import { View, ActivityIndicator } from 'react-native';
import { useAuthStore } from '@/store/authStore';
import { colors } from '@/constants/theme';

export default function RootLayout() {
  const { isLoading, isLoggedIn, setSession } = useAuthStore();

  useEffect(() => {
    // DEV MODE: no Supabase — just mark loading done
    setSession(null);
  }, []);

  useEffect(() => {
    if (isLoading) return;
    if (isLoggedIn) {
      router.replace('/(app)/report-card');
    } else {
      router.replace('/(auth)/sign-in');
    }
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
      <Stack.Screen name="(auth)"     options={{ headerShown: false }} />
      <Stack.Screen name="(app)"      options={{ headerShown: false }} />
      <Stack.Screen name="onboarding" options={{ headerShown: false }} />
    </Stack>
  );
}