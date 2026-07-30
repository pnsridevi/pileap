/**
 * src/lib/api/userCategories.ts
 *
 * Supabase read/write layer for `user_categories` — see
 * supabase/migrations/create_user_categories.sql for the full reasoning.
 *
 * WHAT THIS SOLVES: custom_categories only ever taught the app "this
 * merchant -> this category," so a category typed via "+ Add new" for one
 * merchant never appeared as a chip option for a DIFFERENT merchant later.
 * This table has no merchant column and is NOT part of the auto-
 * categorization pipeline (custom_categories -> registered_facts ->
 * smsParser TAXONOMY -> uncategorized, unchanged). It's purely a second
 * data source for the UI's category/subcategory chip picker — merge the
 * result of fetchUserCategories() with the built-in TAXONOMY constant
 * wherever chips are rendered (EditModal.tsx, SplitFlow.tsx, add.tsx).
 */
import { supabase } from '../supabase';
import type { TxnType } from '../../constants/transactionTaxonomy';

async function getCurrentUserId(): Promise<string> {
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    throw new Error('Not authenticated — no user_id available for this request.');
  }
  return user.id;
}

export interface UserCategoryRow {
  id: string;
  type: TxnType;
  category: string;
  sub_category: string | null;
}

/** Every category/subcategory pair the current user has ever typed via
 * "+ Add new," across any merchant. Call once per screen mount (same
 * pattern as fetchCustomCategories) and merge into TAXONOMY client-side —
 * this table is small (one row per distinct pair a user has ever typed),
 * so no pagination here. */
export async function fetchUserCategories(): Promise<UserCategoryRow[]> {
  const userId = await getCurrentUserId();
  const { data, error } = await supabase
    .from('user_categories')
    .select('id, type, category, sub_category')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });

  if (error) throw error;
  // [ADD] Table stores '' for "no subcategory" (see migration's docblock
  // on why, re: Supabase upsert onConflict needing a plain constraint).
  // Translate back to null here so every consumer of this function works
  // with the same null-means-none convention used everywhere else in the
  // codebase (custom_categories, TAXONOMY, etc.) — that storage detail
  // shouldn't leak past this file.
  return ((data ?? []) as UserCategoryRow[]).map((row) => ({
    ...row,
    sub_category: row.sub_category || null,
  }));
}

/**
 * Records a category/subcategory pair the user just typed via "+ Add new,"
 * so it appears as a selectable chip for any merchant next time — not just
 * the one it was originally typed for. Upsert against the
 * (user_id, category, coalesce(sub_category,'')) expression index (see
 * migration), so calling this again with the same pair is a no-op rather
 * than a duplicate row or an error.
 *
 * Call this alongside — not instead of — the existing custom_categories
 * save (saveCustomCategory in customCategories.ts) when the "save this
 * category for this merchant" switch is on: they answer two different
 * questions ("what should THIS merchant map to" vs "what categories exist
 * at all for me to pick from"), and a user can want either without the
 * other — e.g. adding a new category without saving a merchant mapping
 * (switch off), or saving a mapping using an EXISTING category (nothing
 * new to add here at all). Call this specifically at the moment a new
 * category/subcategory is typed in, regardless of that switch's state.
 */
/**
 * Merges this user's saved category/subcategory pairs into a TAXONOMY[type]
 * category-defs array, for rendering the chip picker. Shared here rather
 * than reimplemented in EditModal.tsx/SplitFlow.tsx/add.tsx separately —
 * same reasoning as normaliseMerchantKey() being centralized in
 * smsParser.ts: one source of truth for "what counts as a match/merge."
 *
 * - Filters userRows to this `type` only (a category saved under Expense
 *   must not leak into the Income chip list).
 * - A user category matching an existing TAXONOMY category name adds its
 *   subcategory into that entry (deduped) rather than creating a second,
 *   duplicate chip with the same label.
 * - A genuinely new category name is appended as a new entry.
 * Returns a new array — does not mutate the taxonomyDefs argument.
 */
export function mergeUserCategoriesIntoTaxonomy(
  taxonomyDefs: { category: string; subCategories?: string[] }[],
  userRows: UserCategoryRow[],
  type: TxnType,
): { category: string; subCategories: string[] }[] {
  const merged = taxonomyDefs.map((d) => ({ category: d.category, subCategories: [...(d.subCategories ?? [])] }));
  for (const row of userRows) {
    if (row.type !== type) continue;
    let entry = merged.find((d) => d.category === row.category);
    if (!entry) {
      entry = { category: row.category, subCategories: [] };
      merged.push(entry);
    }
    if (row.sub_category && !entry.subCategories.includes(row.sub_category)) {
      entry.subCategories.push(row.sub_category);
    }
  }
  return merged;
}

export async function saveUserCategory(
  type: TxnType,
  category: string,
  subCategory: string | null,
): Promise<void> {
  const userId = await getCurrentUserId();
  const trimmedCategory = category.trim();
  if (!trimmedCategory) return;

  const { error } = await supabase
    .from('user_categories')
    .upsert(
      {
        user_id: userId,
        type,
        category: trimmedCategory,
        // [ADD] '' not null — see migration docblock. onConflict below
        // requires this to exactly match the real unique constraint,
        // which only works reliably against a plain (non-nullable,
        // non-expression) column.
        sub_category: subCategory?.trim() || '',
      },
      { onConflict: 'user_id,type,category,sub_category' },
    );
  if (error) throw error;
}