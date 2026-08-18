/**
 * app/(app)/profile/_layout.tsx
 *
 * [ADD] Registered 'accounts' explicitly, matching transactions/_layout.tsx's
 * pattern — was previously an empty <Stack screenOptions={{headerShown:false}} />
 * with no children listed, which still worked for 'index' via Expo Router's
 * automatic file-based resolution, but making 'accounts' explicit here keeps
 * this file self-documenting about what actually lives under Profile now.
 */
import { Stack } from 'expo-router';

export default function ProfileLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="accounts" options={{ headerShown: false }} />
    </Stack>
  );
}