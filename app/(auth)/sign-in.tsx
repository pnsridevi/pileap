import { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, SafeAreaView } from 'react-native';
import { router } from 'expo-router';
import { sendOtp, verifyOtpAndSignIn } from '@/lib/auth';
import { colors, spacing, fontSize, fontWeight, radius, shadows } from '@/constants/theme';

export default function SignInScreen() {
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSendOtp() {
    setError(null);
    setLoading(true);
    const { error } = await sendOtp(phone);
    setLoading(false);
    if (error) { setError(error.message); return; }
    setStep('otp');
  }

  async function handleVerifyOtp() {
    setError(null);
    setLoading(true);
    const { data, error } = await verifyOtpAndSignIn(phone, otp);
    setLoading(false);
    if (error || !data.session) { setError(error?.message ?? 'Invalid code'); return; }
    router.replace('/(app)/report-card');
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
          <Text style={styles.sub}>{step === 'phone' ? 'Enter your phone number' : `Enter the code sent to ${phone}`}</Text>
        </View>

        {step === 'phone' ? (
          <TextInput
            style={styles.input}
            placeholder="+91XXXXXXXXXX"
            keyboardType="phone-pad"
            value={phone}
            onChangeText={setPhone}
            autoFocus
          />
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
  error:        { color: colors.amber, fontSize: fontSize.xs },
  btn:          { backgroundColor: colors.brand, paddingVertical: 14, borderRadius: radius.lg, alignItems: 'center', ...shadows.md },
  btnText:      { color: colors.white, fontSize: fontSize.md, fontWeight: fontWeight.semibold },
  link:         { color: colors.brand, fontSize: fontSize.sm, textAlign: 'center' },
});