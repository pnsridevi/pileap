/**
 * src/components/ui/Button.tsx
 *
 * Base pressable action. Three variants covering what the demo's
 * btn-primary / btn-ghost / danger-action patterns need; two sizes
 * (md default, sm for inline row/footer actions like Submit Changes,
 * Previous/Next).
 */
import { Pressable, Text, StyleSheet, ActivityIndicator, PressableProps } from 'react-native';
import { colors, radius, spacing, fontSize, fontWeight } from '@/constants/theme';

export type ButtonVariant = 'primary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

interface ButtonProps extends Omit<PressableProps, 'style'> {
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  disabled?: boolean;
}

const VARIANT_STYLES: Record<ButtonVariant, { bg: string; text: string; border?: string }> = {
  primary: { bg: colors.brand, text: colors.white },
  ghost:   { bg: 'transparent', text: colors.mid, border: colors.border },
  danger:  { bg: colors.red, text: colors.white },
};

export function Button({ label, variant = 'primary', size = 'md', loading, disabled, ...rest }: ButtonProps) {
  const v = VARIANT_STYLES[variant];
  const isDisabled = !!disabled || !!loading;

  return (
    <Pressable
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.base,
        size === 'sm' ? styles.sm : styles.md,
        {
          backgroundColor: v.bg,
          borderColor: v.border ?? 'transparent',
          borderWidth: v.border ? 1 : 0,
        },
        isDisabled && styles.disabled,
        pressed && !isDisabled && styles.pressed,
      ]}
      {...rest}
    >
      {loading ? (
        <ActivityIndicator size="small" color={v.text} />
      ) : (
        <Text style={[styles.text, size === 'sm' ? styles.textSm : styles.textMd, { color: v.text }]} numberOfLines={1}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
  md: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  sm: { paddingHorizontal: spacing.md, paddingVertical: 6 },
  text: { fontWeight: fontWeight.semibold },
  textMd: { fontSize: fontSize.base },
  textSm: { fontSize: fontSize.sm },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.85 },
});