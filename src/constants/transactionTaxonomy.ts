/**
 * src/constants/transactionTaxonomy.ts
 *
 * [REWRITTEN] This used to define its own, smaller, hand-invented
 * category/subcategory set ('Food', 'Housing'...) that didn't match
 * smsParser.ts's real 30-category/51-subcategory taxonomy at all, and
 * ALSO didn't match constants/categories.ts's lookup keys — so picking a
 * category here in EditModal/SplitFlow still wouldn't render correctly
 * afterward in TransactionRow. This file's own original docblock already
 * flagged the risk of a second source of truth; see
 * transactionCategories.ts for the actual resolution.
 *
 * Now a thin re-export so every existing
 * `import { TAXONOMY, TxnType, signedAmount } from
 * '@/constants/transactionTaxonomy'` (EditModal.tsx, SplitFlow.tsx) keeps
 * working with zero code changes in those files — only the underlying
 * data changed to match what smsParser.ts actually produces, plus a
 * handful of manual-only additions for events the SMS parser can't detect
 * (see transactionCategories.ts's comments on POSITIVE_SUB_CATEGORIES).
 */
export { TAXONOMY, type TxnType, type CategoryDef, signedAmount } from './transactionCategories';