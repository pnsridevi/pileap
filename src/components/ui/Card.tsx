/**
 * src/components/ui/Card.tsx
 *
 * Base surface for rows, sections, and grouped content. Kept deliberately
 * plain — padding/shadow/border only — so it composes under list rows,
 * form sections, and summary panels without fighting their own layout.
 */
import { View, ViewProps, StyleSheet } from 'react-native';
import { colors, radius, spacing, shadows } from '@/constants/theme';

interface CardProps extends ViewProps {
  /** Removes the default padding — useful when a child (e.g. TransactionRow) manages its own internal spacing. */
  noPadding?: boolean;
  /** Drops the shadow — useful when stacking cards edge-to-edge with only a border between them. */
  flat?: boolean;
}

export function Card({ noPadding, flat, style, children, ...rest }: CardProps) {
  return (
    <View
      style={[
        styles.card,
        !flat && shadows.sm,
        noPadding && styles.noPadding,
        style,
      ]}
      {...rest}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border2,
    padding: spacing.md,
  },
  noPadding: {
    padding: 0,
  },
});