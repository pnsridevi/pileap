/**
 * src/constants/categories.ts
 *
 * Category taxonomy for classifying transactions. Each category carries its
 * own color so TransactionRow / filter chips don't need a switch-statement
 * scattered across components — look it up once here.
 *
 * `key` is what's stored in transactions.category (per arch doc). `label` is
 * what's shown in the UI. Extend this list freely — nothing else needs to
 * change when a new category is added, since color/label are derived via
 * getCategory() below.
 */

export interface Category {
  key: string;
  label: string;
  color: string;
}

export const CATEGORIES: Category[] = [
  { key: 'food_dining',       label: 'Food & Dining',     color: '#E8590C' },
  { key: 'groceries',         label: 'Groceries',         color: '#2B8A3E' },
  { key: 'transport',         label: 'Transport',         color: '#1971C2' },
  { key: 'shopping',          label: 'Shopping',          color: '#AE3EC9' },
  { key: 'bills_utilities',   label: 'Bills & Utilities', color: '#F08C00' },
  { key: 'entertainment',     label: 'Entertainment',     color: '#D6336C' },
  { key: 'health',            label: 'Health',            color: '#0CA678' },
  { key: 'travel',            label: 'Travel',            color: '#0C8599' },
  { key: 'rent_housing',      label: 'Rent & Housing',    color: '#5C7CFA' },
  { key: 'education',         label: 'Education',         color: '#7048E8' },
  { key: 'investments',       label: 'Investments',       color: '#087F5B' },
  { key: 'transfers',         label: 'Transfers',         color: '#868E96' },
  { key: 'income',            label: 'Income',            color: '#2B8A3E' },
  { key: 'fees_charges',      label: 'Fees & Charges',    color: '#C92A2A' },
  { key: 'uncategorized',     label: 'Uncategorized',     color: '#868E96' },
];

const CATEGORY_MAP: Record<string, Category> = Object.fromEntries(
  CATEGORIES.map(c => [c.key, c]),
);

const FALLBACK_CATEGORY: Category = CATEGORY_MAP.uncategorized;

/**
 * Looks up a category by its stored key. Falls back to "Uncategorized"
 * (not null) so callers never need their own null-guard — a transaction
 * with a category the app doesn't recognize yet (new rule, manual entry)
 * still renders sensibly instead of showing an empty badge.
 */
export function getCategory(key: string | null | undefined): Category {
  if (!key) return FALLBACK_CATEGORY;
  return CATEGORY_MAP[key] ?? FALLBACK_CATEGORY;
}