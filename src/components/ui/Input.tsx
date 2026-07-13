/**
 * src/components/ui/Input.tsx
 *
 * Labeled text input with an optional inline error message. Covers the
 * date/amount/merchant text fields in EditModal and SplitFlow — doesn't
 * try to be a date picker or numeric stepper, just a styled TextInput.
 */
import { View, Text, TextInput, TextInputProps, StyleSheet } from 'react-native';
import { colors, radius, spacing, fontSize, fontWeight } from '@/constants/theme';

interface InputProps extends TextInputProps {
  label?: string;
  error?: string;
}

export function Input({ label, error, style, ...rest }: InputProps) {
  return (
    <View style={styles.wrapper}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <TextInput
        style={[styles.input, !!error && styles.inputError, style]}
        placeholderTextColor={colors.muted}
        {...rest}
      />
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    marginBottom: spacing.sm,
  },
  label: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    color: colors.mid,
    marginBottom: spacing.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    fontSize: fontSize.base,
    color: colors.dark,
  },
  inputError: {
    borderColor: colors.red,
  },
  errorText: {
    fontSize: fontSize.xs,
    color: colors.red,
    marginTop: 2,
  },
});