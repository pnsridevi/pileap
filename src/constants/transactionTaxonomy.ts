/**
 * src/constants/transactionTaxonomy.ts
 *
 * Category/sub-category taxonomy per arch doc Section 4.8 (module tagging)
 * and 5.3.4 (amount sign convention).
 *
 * NOTE: `src/constants/categories.ts` already exists in the repo and may
 * already define this. This file was added standalone because I don't have
 * that file's contents/exports in this pass — if categories.ts already
 * covers this, delete this file and point EditModal/SplitFlow/the filter
 * dropdown at that one instead to avoid two sources of truth.
 */

export type TxnType = 'Expense' | 'Income' | 'Investment' | 'Liability' | 'Asset';

export interface CategoryDef {
  category: string;
  /** Sub-categories that flip the amount sign per 5.3.4. Empty = category
   * has no sign-determining sub-category (sign is fixed by type instead). */
  subCategories?: string[];
}

export const TAXONOMY: Record<TxnType, CategoryDef[]> = {
  Expense: [
    { category: 'Food' },
    { category: 'Travel' },
    { category: 'Shopping' },
    { category: 'Utilities' },
    { category: 'Housing', subCategories: ['Rent'] },
    { category: 'Medical' },
    { category: 'Entertainment' },
    { category: 'Education' },
    { category: 'Insurance Premium' },
    { category: 'Other Expense' },
  ],
  Income: [
    { category: 'Salary' },
    { category: 'Consulting Fee' },
    { category: 'Rental Income' },
    { category: 'Business Income' },
  ],
  Investment: [
    // Sub-category determines sign per 5.3.4: SIP/Lumpsum/New FD/
    // Contribution/Buy -> negative, Maturity/Sell/Redemption -> positive.
    { category: 'Mutual Fund', subCategories: ['SIP', 'Lumpsum', 'Redemption'] },
    { category: 'Equity', subCategories: ['Buy', 'Sell'] },
    { category: 'Gold', subCategories: ['Buy', 'Sell'] },
    { category: 'Fixed Deposit', subCategories: ['New FD', 'Maturity'] },
    { category: 'EPF', subCategories: ['Contribution'] },
    { category: 'NPS', subCategories: ['Contribution'] },
    { category: 'PPF', subCategories: ['Contribution'] },
  ],
  Liability: [
    { category: 'Home Loan EMI' },
    { category: 'Credit Card EMI' },
    { category: 'Personal Loan EMI' },
    { category: 'Other Loan EMI' },
  ],
  Asset: [
    // Sub-category determines sign: Purchase -> negative, Sale -> positive.
    { category: 'Real Estate', subCategories: ['Purchase', 'Sale'] },
    { category: 'Vehicle', subCategories: ['Purchase', 'Sale'] },
  ],
};

const POSITIVE_SUB_CATEGORIES = new Set([
  'Maturity', 'Sell', 'Redemption', 'Sale',
]);

/** Returns the signed amount given a magnitude + type + optional
 * sub-category, per arch doc 5.3.4. */
export function signedAmount(magnitude: number, type: TxnType, subCategory?: string | null): number {
  const abs = Math.abs(magnitude);
  if (type === 'Income') return abs;
  if (subCategory && POSITIVE_SUB_CATEGORIES.has(subCategory)) return abs;
  return -abs;
}