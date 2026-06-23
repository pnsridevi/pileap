import { View, Text, StyleSheet, SafeAreaView } from 'react-native';
import { colors, spacing, fontSize, fontWeight } from '@/constants/theme';

export default function ReportCardScreen() {
  return (
    <SafeAreaView style={s.safe}>
      <View style={s.container}>
        <Text style={s.eyebrow}>GOALS</Text>
        <Text style={s.title}>Active goals + trajectory</Text>
        <Text style={s.note}>Build after Goal Tracking (Section 7)</Text>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe:      { flex: 1, backgroundColor: colors.surface },
  container: { flex: 1, padding: spacing.lg, justifyContent: 'center', alignItems: 'center', gap: spacing.sm },
  eyebrow:   { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.brand, letterSpacing: 1 },
  title:     { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: colors.dark, textAlign: 'center' },
  note:      { fontSize: fontSize.sm, color: colors.muted, textAlign: 'center' },
});