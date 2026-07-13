/**
 * src/components/ui/Badge.tsx
 *
 * Small pill label. Two ways to use it:
 *   <Badge variant="pending" label="Pending Review" />        — fixed status colors
 *   <Badge color={category.color} label={category.label} />   — category chips,
 *     any hex color in, a tinted background + solid text derived automatically.
 */
import { View, Text, StyleSheet } from 'react-native';
import { colors, radius, spacing, fontSize, fontWeight } from '@/constants/theme';

export type BadgeVariant = 'pending' | 'approved' | 'history' | 'transfer' | 'neutral';

interface BadgeProps {
  label: string;
  variant?: BadgeVariant;
  /** Overrides variant — used for category chips where color comes from data, not a fixed enum. */
  color?: string;
}

const VARIANT_STYLES: Record<BadgeVariant, { bg: string; text: string }> = {
  pending:  { bg: colors.amberLight, text: colors.amber },
  approved: { bg: colors.greenLight, text: colors.green },
  // no historyLight token exists — border2/muted reads correctly as an
  // inactive/archived state without inventing a new theme color.
  history:  { bg: colors.border2, text: colors.muted },
  transfer: { bg: colors.brandLight, text: colors.brand },
  neutral:  { bg: colors.border2, text: colors.mid },
};

/** Tints an arbitrary hex color to ~12% opacity for the chip background, keeping the solid hex for text. */
function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const bigint = parseInt(clean, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function Badge({ label, variant = 'neutral', color }: BadgeProps) {
  const { bg, text } = color
    ? { bg: hexToRgba(color, 0.12), text: color }
    : VARIANT_STYLES[variant];

  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={[styles.label, { color: text }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.full,
    alignSelf: 'flex-start',
  },
  label: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
  },
});