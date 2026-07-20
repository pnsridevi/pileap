/**
 * src/constants/categories.ts
 *
 * [REWRITTEN] This used to define its own CATEGORIES list, keyed by
 * snake_case ids ('food_dining', 'bills_utilities'...) that never matched
 * the actual category strings smsParser.ts writes to transactions.category
 * ('Food & Dining', 'Utilities'...). getCategory() did a direct
 * CATEGORY_MAP[key] lookup against those mismatched keys, so it ALWAYS
 * fell through to the "Uncategorized" fallback — even for transactions
 * that parsed and categorized correctly. See transactionCategories.ts for
 * the full explanation and the actual data.
 *
 * Now a thin re-export so every existing `import { getCategory } from
 * '@/constants/categories'` (TransactionRow.tsx) keeps working with zero
 * code changes there — only the underlying data/logic moved.
 */
export { getCategory, type ResolvedCategory } from './transactionCategories';