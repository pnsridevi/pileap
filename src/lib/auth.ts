import { supabase } from './supabase';
import { useAuthStore } from '@/store/authStore';

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

export async function signOut() {
  await supabase.auth.signOut();
  useAuthStore.getState().signOut();
}