import { supabase } from './supabase';
import { useAuthStore } from '@/store/authStore';

// [REMOVED] TEST_AUTH_MODE and testSignInWithPhone() — the custom
// test-phone-auth Edge Function bypass that accepted ANY phone number
// with a fixed test code. Removed because it was the actual security gap
// flagged this session: anyone who typed someone else's number could see
// their transactions, with no real ownership check. Replaced by
// Supabase's own dashboard test-numbers list (Auth -> Providers -> Phone)
// combined with the real signInWithOtp()/verifyOtp() pair below — only
// numbers explicitly added there can request a code at all.
// The supabase/functions/test-phone-auth Edge Function itself and the
// EXPO_PUBLIC_TEST_AUTH_MODE / EXPO_PUBLIC_TEST_AUTH_SHARED_SECRET env
// vars are now unused by the app; left deployed/set for now rather than
// deleted, in case reverting is ever needed — safe to remove for real
// once this flow is confirmed stable.

// Step 1 of login: send a real OTP to this phone. Only succeeds for
// numbers on the Supabase dashboard's test-numbers list right now (real
// SMS provider isn't fully live — see the DLT discussion).
export async function sendOtp(phone: string) {
  return supabase.auth.signInWithOtp({ phone });
}

// Step 2 of login: verify the code and, on success, push the session into the store.
export async function verifyOtpAndSignIn(phone: string, token: string) {
  const { data, error } = await supabase.auth.verifyOtp({
    phone,
    token,
    type: 'sms',
  });
  if (!error && data.session) {
    useAuthStore.getState().setSession(data.session);
  }
  return { data, error };
}

export async function signOut() {
  await supabase.auth.signOut();
  useAuthStore.getState().signOut();
}