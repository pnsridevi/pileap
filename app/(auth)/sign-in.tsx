import { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, SafeAreaView } from 'react-native';
import { router } from 'expo-router';
import { sendOtp, verifyOtpAndSignIn } from '@/lib/auth';
import { colors, spacing, fontSize, fontWeight, radius, shadows } from '@/constants/theme';

export default function SignInScreen() {
  // [CHANGE] `phone` now holds only the 10 local digits, not the full
  // +91XXXXXXXXXX string — see the fullPhone derivation below. Keeps the
  // input itself simple to cap at 10 digits without fighting a mixed
  // "+91" + digits string in the same field.
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // [ADD] E.164 format Supabase/the SMS provider actually need. +91 is
  // hardcoded here rather than user-entered — this app is India-only per
  // the DLT discussion, so a fixed country code removes a whole class of
  // malformed-number errors instead of trusting free-text input for it.
  const fullPhone = `+91${phone}`;

  async function handleSendOtp() {
    setError(null);
    // [ADD] Catch an incomplete number before it ever reaches Supabase —
    // clearer than waiting on a provider-side error for something this
    // easy to check client-side.
    if (phone.length !== 10) {
      setError('Enter a valid 10-digit phone number.');
      return;
    }
    setLoading(true);
    const { error } = await sendOtp(fullPhone);
    setLoading(false);
    if (error) {
      // [ADD] Show the real Supabase error, not a guessed-at replacement —
      // could be an unapproved number (not on the dashboard's test-numbers
      // list), a rate limit, or a network issue, and collapsing all three
      // into one guessed message would make this as hard to debug as the
      // OTA update issue was. Append a plain-language hint for the most
      // common testing-phase cause without hiding the underlying error.
      setError(`${error.message} (If this number isn't approved for testing yet, contact the team to get it added.)`);
      return;
    }
    setStep('otp');
  }

  async function handleVerifyOtp() {
    setError(null);
    setLoading(true);
    const { data, error } = await verifyOtpAndSignIn(fullPhone, otp);
    setLoading(false);
    if (error || !data.session) { setError(error?.message ?? 'Invalid code'); return; }
    // [CHANGE] Was '/(app)/report-card' — that tab is now hidden via
    // href: null (see app/(app)/_layout.tsx), so landing there after
    // sign-in would put the user on a screen with no active tab
    // highlighted. Transactions matches the root _layout.tsx's own
    // post-session-restore redirect, so both paths land in the same place.
    router.replace('/(app)/transactions');
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        <View style={styles.logoRow}>
          <View style={styles.logoIcon}><Text style={styles.logoIconText}>P</Text></View>
          <Text style={styles.logoText}>Pileap</Text>
        </View>

        <View style={styles.headingBlock}>
          <Text style={styles.heading}>Your financial health,{'\n'}tracked every month.</Text>
          <Text style={styles.sub}>{step === 'phone' ? 'Enter your phone number' : `Enter the code sent to ${fullPhone}`}</Text>
        </View>

        {step === 'phone' ? (
          // [CHANGE] Was a single free-text TextInput accepting the whole
          // "+91XXXXXXXXXX" string with no length limit. Now a fixed "+91"
          // prefix plus an input capped at exactly 10 digits, with any
          // non-digit characters stripped as they're typed (handles paste
          // of a number with spaces/dashes/a typed + gracefully instead of
          // erroring on it).
          <View style={styles.phoneRow}>
            <Text style={styles.phonePrefix}>+91</Text>
            <TextInput
              style={styles.phoneInput}
              placeholder="10-digit number"
              keyboardType="phone-pad"
              value={phone}
              onChangeText={(text) => setPhone(text.replace(/[^0-9]/g, '').slice(0, 10))}
              maxLength={10}
              autoFocus
            />
          </View>
        ) : (
          <TextInput
            style={styles.input}
            placeholder="6-digit code"
            keyboardType="number-pad"
            value={otp}
            onChangeText={setOtp}
            maxLength={6}
            autoFocus
          />
        )}

        {error && <Text style={styles.error}>{error}</Text>}

        <TouchableOpacity
          style={styles.btn}
          onPress={step === 'phone' ? handleSendOtp : handleVerifyOtp}
          activeOpacity={0.85}
          disabled={loading}
        >
          <Text style={styles.btnText}>{loading ? 'Please wait…' : step === 'phone' ? 'Send code' : 'Verify & sign in'}</Text>
        </TouchableOpacity>

        {step === 'otp' && (
          <TouchableOpacity onPress={() => setStep('phone')}>
            <Text style={styles.link}>Use a different number</Text>
          </TouchableOpacity>
        )}
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
  input:        { borderWidth: 1, borderColor: colors.muted, borderRadius: radius.lg, paddingVertical: 12, paddingHorizontal: spacing.md, fontSize: fontSize.md, color: colors.dark },
  // [ADD] Fixed-prefix phone row — border/radius/padding mirror `input`
  // above so the two input styles (phone step vs OTP step) still look
  // like one consistent design, just phone's is a row now.
  phoneRow:     { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: colors.muted, borderRadius: radius.lg, paddingHorizontal: spacing.md },
  phonePrefix:  { fontSize: fontSize.md, color: colors.dark, fontWeight: fontWeight.semibold, marginRight: spacing.xs },
  phoneInput:   { flex: 1, paddingVertical: 12, fontSize: fontSize.md, color: colors.dark },
  error:        { color: colors.amber, fontSize: fontSize.xs },
  btn:          { backgroundColor: colors.brand, paddingVertical: 14, borderRadius: radius.lg, alignItems: 'center', ...shadows.md },
  btnText:      { color: colors.white, fontSize: fontSize.md, fontWeight: fontWeight.semibold },
  link:         { color: colors.brand, fontSize: fontSize.sm, textAlign: 'center' },
});