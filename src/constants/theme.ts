export const colors = {
  brand:        '#7C3AED',
  brandDark:    '#6D28D9',
  brandLight:   'rgba(124,58,237,0.10)',
  green:        '#10B981',
  greenLight:   'rgba(16,185,129,0.10)',
  amber:        '#F59E0B',
  amberLight:   '#FEF3C7',
  red:          '#EF4444',
  redLight:     '#FEE2E2',
  blue:         '#3B82F6',
  dark:         '#111827',
  dark2:        '#0F172A',
  mid:          '#374151',
  muted:        '#6B7280',
  border:       '#E5E7EB',
  border2:      '#F3F4F6',
  surface:      '#F9FAFB',
  white:        '#FFFFFF',
} as const;

export const radius = {
  sm: 6, md: 8, lg: 12, xl: 16, full: 999,
} as const;

export const spacing = {
  xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48,
} as const;

export const fontSize = {
  xs: 11, sm: 13, base: 14, md: 15, lg: 17, xl: 20, xxl: 24, h1: 32,
} as const;

export const fontWeight = {
  regular:   '400' as const,
  medium:    '500' as const,
  semibold:  '600' as const,
  bold:      '700' as const,
  extrabold: '800' as const,
};

export const shadows = {
  sm: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  md: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.07,
    shadowRadius: 6,
    elevation: 3,
  },
} as const;