import 'react-native-url-polyfill/auto';
import { AppState, type AppStateStatus, Platform } from 'react-native';
import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SmsReader } from '../../modules/sms-reader/src/index';

const supabaseUrl  = process.env.EXPO_PUBLIC_SUPABASE_URL  ?? '';
const supabaseAnon = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

export const supabase = createClient(supabaseUrl, supabaseAnon, {
  auth: {
    storage:            AsyncStorage,
    autoRefreshToken:   true,
    persistSession:     true,
    detectSessionInUrl: false,
  },
});

// ─────────────────────────────────────────────────────────────────────────
// [ADD — Nov 4] Only refresh the login on a timer while the app is on screen.
//
// Background syncs (hourly task, SMS listener) start their own copy of the
// app's JS, each with its own Supabase client reading the same saved login.
// With a refresh timer running in each copy, two copies could refresh with
// the same refresh token at about the same moment. Supabase accepts it once
// and rejects the second as "already used"; the library then clears the
// saved login — the user is signed out, and every later background sync
// finds no login and does nothing.
//
// This is Supabase's recommended React Native setup: the timer runs only
// while the app is active. Background copies still refresh when they need
// to — getSession() and every request refresh an expired token on demand.
// ─────────────────────────────────────────────────────────────────────────
if (Platform.OS !== 'web') {
  const applyAppState = (state: AppStateStatus | null | undefined) => {
    if (state === 'active') {
      void supabase.auth.startAutoRefresh();
    } else {
      void supabase.auth.stopAutoRefresh();
    }
  };
  applyAppState(AppState.currentState);
  AppState.addEventListener('change', applyAppState);
}

// [ADD — Nov 4, TESTING] Record every sign-out in the on-phone listener log
// (no network needed; uploaded to background_sync_log after the next login).
// app_state shows which copy of the app it happened in: 'active' = the app on
// screen (e.g. the user tapped Sign out), anything else = a background run.
supabase.auth.onAuthStateChange((event) => {
  if (event !== 'SIGNED_OUT') return;
  if (Platform.OS !== 'android') return;
  SmsReader.recordListenerEvent(
    'auth_signed_out',
    JSON.stringify({ app_state: AppState.currentState ?? 'unknown' }),
  ).catch(() => undefined);
});
