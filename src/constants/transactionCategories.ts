/**
 * src/constants/transactionCategories.ts
 *
 * SINGLE SOURCE OF TRUTH for category/subcategory data, used by both the
 * auto-categorization side (smsParser.ts's own TAXONOMY array — kept
 * independent since that one runs in a different runtime context, but the
 * category/sub_category STRINGS here are kept in exact sync with it) and
 * every UI surface that displays or edits categories (TransactionRow,
 * EditModal, SplitFlow, the Transactions tab filter).
 *
 * WHY THIS FILE EXISTS — three previously-separate, disagreeing taxonomies
 * were found in this codebase:
 *   1. smsParser.ts's own TAXONOMY (30 categories / 51 subcategories) —
 *      the only one actually used for auto-categorization; writes strings
 *      like 'Food & Dining', 'Subscriptions' into transactions.category.
 *   2. constants/categories.ts's CATEGORIES — a smaller, differently-KEYED
 *      list (snake_case ids like 'food_dining', 'bills_utilities') used by
 *      getCategory() for badge color/label lookup.
 *   3. constants/transactionTaxonomy.ts's TAXONOMY — a third, smaller,
 *      hand-invented set ('Food', 'Housing'...) used only by EditModal and
 *      SplitFlow's category/subcategory pickers.
 * Since (2)'s lookup keys never matched (1)'s actual output strings, ANY
 * transaction's category badge — even a correctly auto-categorized one —
 * always fell through to "Uncategorized". And since (3) used yet another
 * vocabulary, a manual edit via EditModal wouldn't match (2)'s keys either,
 * so even a corrected transaction still rendered as Uncategorized.
 *
 * This file fixes that by being the one place both belong to.
 * constants/categories.ts and constants/transactionTaxonomy.ts now both
 * re-export from here (see those files) so every existing import
 * (`getCategory` from categories.ts, `TAXONOMY`/`signedAmount` from
 * transactionTaxonomy.ts) keeps working unchanged in TransactionRow.tsx,
 * EditModal.tsx, SplitFlow.tsx, and index.tsx — only the underlying data
 * changed, not any component's code.
 *
 * MAINTENANCE: if smsParser.ts's TAXONOMY array gains a new category or
 * subcategory, mirror the exact same category/sub_category strings here
 * (plus a color, plus any manual-only sign-flip subcategories you want to
 * offer for hand-entry) or the badge-lookup bug above will silently
 * reappear for that new category.
 */

export type TxnType = 'Expense' | 'Income' | 'Investment' | 'Liability' | 'Asset';

export interface CategoryDef {
  category: string;
  color: string;
  /** Subcategories offered in the UI. Includes every sub_category value
   * smsParser.ts's TAXONOMY can actually produce for this category, PLUS
   * a small number of manual-only additions (commented inline below) for
   * events the SMS parser can't detect on its own — e.g. a mutual fund
   * redemption or an FD maturity, which show up as a CREDIT SMS with no
   * reliable text signal tying them back to the original investment.
   * Manual-only entries are marked so it's clear the parser will never
   * produce them itself. */
  subCategories?: string[];
}

// [ADD] Sub-categories where the amount should be POSITIVE (money coming
// IN) even though their category's `type` might suggest otherwise (e.g. an
// Investment redemption is still money returning to the user). Used by
// signedAmount() below. Real, parser-producible sub_categories from
// smsParser.ts are never in this set — the parser already encodes sign
// correctly via isCredit at parse time. This set only matters for MANUAL
// entry (EditModal/SplitFlow), where the user is telling the app the sign
// via which subcategory they picked, not via a parsed bank SMS.
const POSITIVE_SUB_CATEGORIES = new Set([
  'Redemption',      // Investment > Mutual Funds — manual only
  'Equity Sale',     // Investment > Stocks — manual only
  'Sale',            // Investment > Gold, Asset > Real Estate/Vehicle — manual only
  'FD Maturity',     // Asset > Bank Deposits — manual only
]);

export const TAXONOMY: Record<TxnType, CategoryDef[]> = {
  Expense: [
    { category: 'Food & Dining', color: '#E8590C',
      subCategories: ['Quick Commerce', 'Restaurants', 'Groceries', 'Milk & Dairy'] },
    { category: 'Entertainment', color: '#D6336C',
      subCategories: ['OTT Subscriptions', 'Movies & Events'] },
    { category: 'Shopping', color: '#AE3EC9',
      subCategories: ['Online Shopping', 'Electronics'] },
    { category: 'Transportation', color: '#1971C2',
      subCategories: ['Tolls & FASTag', 'Ride Hailing', 'Fuel', 'Bus', 'Public Transit', 'Parking', 'Vehicle Service & Repair'] },
    { category: 'Utilities', color: '#F08C00',
      subCategories: ['Electricity', 'Gas', 'Piped Gas', 'Water', 'DTH & Cable TV', 'Broadband'] },
    { category: 'Telecom', color: '#4C6EF5',
      subCategories: ['Mobile Recharge'] },
    { category: 'Healthcare', color: '#0CA678',
      subCategories: ['Pharmacy', 'Hospital & Clinic'] },
    { category: 'Education', color: '#7048E8',
      subCategories: ['Tuition & Courses'] },
    { category: 'Travel', color: '#0C8599',
      subCategories: ['Flight', 'Accommodation', 'General Travel'] },
    { category: 'Rent & Housing', color: '#5C7CFA',
      subCategories: ['House Rent', 'Maintenance & Society Charges'] },
    { category: 'Finance Charges', color: '#C92A2A',
      subCategories: ['Cash Withdrawal', 'Bank Charges'] },
    { category: 'Household', color: '#A9762A',
      subCategories: ['Newspaper & Magazine', 'Home Services', 'Stationery'] },
    { category: 'Personal Care', color: '#E64980' },
    { category: 'Fitness & Gym', color: '#37B24D' },
    { category: 'Courier & Postal', color: '#495057' },
    { category: 'Taxes & Government', color: '#862E9C' },
    { category: 'Subscriptions', color: '#F03E3E' },
  ],
  Income: [
    { category: 'Salary', color: '#2B8A3E',
      subCategories: ['Monthly Salary'] },
    // [ADD — this pass] 'Payment Reversal' — companion to smsParser.ts's
    // split of the old single Refunds pattern. A reversal is your own
    // money bouncing back from a failed payment, not a merchant refund —
    // kept in the same category (so existing contra-exclusion behavior is
    // unaffected) but a distinct sub_category so it renders correctly and
    // can be told apart from real refund income downstream.
    { category: 'Refunds', color: '#40C057',
      subCategories: ['Purchase Refund', 'Payment Reversal'] },
    { category: 'Passive Income', color: '#12B886',
      subCategories: ['Interest Income'] },
    { category: 'Dividends', color: '#099268',
      subCategories: ['Stock Dividend'] },
       { category: 'Bank Deposit', color: '#1098AD', subCategories: ['Cheque'] }, 
  ],
  Investment: [
    { category: 'Mutual Funds', color: '#087F5B',
      // 'Redemption' — manual only, see POSITIVE_SUB_CATEGORIES above.
      subCategories: ['SIP', 'Redemption'] },
    { category: 'Stocks', color: '#0B7285',
      // 'Equity Sale' — manual only.
      subCategories: ['Equity Purchase', 'Equity Sale'] },
    { category: 'Gold', color: '#F59F00',
      // Both manual only — smsParser.ts has no sub_category for Gold yet.
      subCategories: ['Purchase', 'Sale'] },
    // [ADD — this pass] Required companion to smsParser.ts's new
    // Investment > Bonds > Bond Purchase TAXONOMY entry — without this,
    // those transactions parse correctly but render as "Uncategorized" in
    // the UI (getCategory() finds no 'Bonds' key in COLOR_BY_CATEGORY).
    // Color chosen distinct from every existing category color above.
    { category: 'Bonds', color: '#7950F2',
      subCategories: ['Bond Purchase'] },
    { category: 'Insurance', color: '#364FC7',
      subCategories: ['Life Insurance', 'Health Insurance', 'Motor Insurance'] },
  ],
  Liability: [
    { category: 'EMI', color: '#E03131',
      subCategories: ['Loan EMI'] },
    { category: 'Loans', color: '#C2255C',
      subCategories: ['Home Loan', 'Personal Loan'] },
    { category: 'Recurring Payment', color: '#9C36B5',
      subCategories: ['NACH Mandate'] },
  ],
  Asset: [
    { category: 'Bank Deposits', color: '#1864AB',
      // 'FD Maturity' — manual only.
      subCategories: ['Fixed Deposit', 'FD Maturity'] },
    { category: 'Government Schemes', color: '#2F9E44',
      subCategories: ['NPS', 'PPF/SSY'] },
    // [ADD] Real Estate / Vehicle — MANUAL-ONLY categories. smsParser.ts
    // has no rule that will ever auto-produce these (no bank SMS template
    // reliably signals "this was a property/vehicle purchase" vs. any
    // other large transfer) — preserved from the original
    // transactionTaxonomy.ts, which already offered them for hand-entry.
    // Kept here rather than dropped, since removing them would be a real
    // loss of manual-entry capability, not a correctness fix.
    { category: 'Real Estate', color: '#5F3DC4',
      subCategories: ['Purchase', 'Sale'] },
    { category: 'Vehicle', color: '#146C43',
      subCategories: ['Purchase', 'Sale'] },
  ],
};

const UNCATEGORIZED_COLOR = '#868E96';

/** Flat lookup: category string -> { color }, built once from TAXONOMY
 * above so there is exactly one place these colors are ever defined. */
const COLOR_BY_CATEGORY: Record<string, string> = {};
for (const defs of Object.values(TAXONOMY)) {
  for (const def of defs) COLOR_BY_CATEGORY[def.category] = def.color;
}

export interface ResolvedCategory {
  label: string;
  color: string;
}

/** Looks up a category by the exact string stored in transactions.category
 * (NOT a separate slug/key — that mismatch was the bug this file fixes).
 * Falls back to "Uncategorized" so callers never need their own null
 * guard — an unrecognized category still renders sensibly instead of an
 * empty badge. */
export function getCategory(category: string | null | undefined): ResolvedCategory {
  if (!category || !COLOR_BY_CATEGORY[category]) {
    return { label: 'Uncategorized', color: UNCATEGORIZED_COLOR };
  }
  return { label: category, color: COLOR_BY_CATEGORY[category] };
}

/** Returns the signed amount given a magnitude + type + optional
 * sub-category — used by EditModal/SplitFlow when the user hand-enters an
 * amount, since the sign there comes from which subcategory they picked
 * rather than from parsed bank-SMS direction. */
export function signedAmount(magnitude: number, type: TxnType, subCategory?: string | null): number {
  const abs = Math.abs(magnitude);
  if (type === 'Income') return abs;
  if (subCategory && POSITIVE_SUB_CATEGORIES.has(subCategory)) return abs;
  return -abs;
}