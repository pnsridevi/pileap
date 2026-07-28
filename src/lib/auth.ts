import { supabase } from './supabase';
import { useAuthStore } from '@/store/authStore';

// [ADD] Test-only sign-in path — see supabase/functions/test-phone-auth.
// Gated behind an env flag so switching between test/real auth is a
// one-line config change, never a code change, minimizing the risk of
// this accidentally shipping to production.
export const TEST_AUTH_MODE = process.env.EXPO_PUBLIC_TEST_AUTH_MODE === 'true';

const TEST_AUTH_FUNCTION_URL = `${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1/test-phone-auth`;
const TEST_AUTH_SHARED_SECRET = process.env.EXPO_PUBLIC_TEST_AUTH_SHARED_SECRET ?? '';

// Step 1 of login: send an OTP (or accept a test number silently) to this phone.
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

// [ADD] TEST-ONLY replacement for the sendOtp -> verifyOtpAndSignIn pair
// above. Skips real SMS entirely: the Edge Function checks the fixed
// test code, looks up-or-creates the user by phone, and mints a real
// session via a magiclink-token exchange (see the function's docblock
// for why). One network round trip does the whole lookup-or-create +
// sign-in, unlike the real flow's separate send/verify steps.
export async function testSignInWithPhone(phone: string, otp: string) {
  try {
    const res = await fetch(TEST_AUTH_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-auth-secret': TEST_AUTH_SHARED_SECRET,
      },
      body: JSON.stringify({ phone, otp }),
    });
    const body = await res.json();
    if (!res.ok) {
      return { data: { session: null }, error: new Error(body?.error ?? 'Sign-in failed') };
    }

    const { data, error } = await supabase.auth.verifyOtp({
      token_hash: body.token,
      type: 'email',
    });
    if (!error && data.session) {
      useAuthStore.getState().setSession(data.session);
    }
    return { data, error };
  } catch (e) {
    return { data: { session: null }, error: e instanceof Error ? e : new Error(String(e)) };
  }
}

export async function signOut() {
  await supabase.auth.signOut();
  useAuthStore.getState().signOut();
}