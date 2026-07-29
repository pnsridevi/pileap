/**
 * src/lib/api/customCategories.ts
 *
 * Supabase read/write layer for custom_categories — closes the gap flagged
 * in transactions.ts's KNOWN GAPS #8 ("the 'save this category for this
 * merchant' checkbox in EditModal is UI-only right now... wire it up once
 * custom_categories write functions exist").
 *
 * WHAT THIS SOLVES — two different reasons a merchant might lack a
 * category, both handled the same way here (per pileap_module_merchant_
 * taxonomy.md's [CUSTOM] tag):
 *   1. No universal SMS pattern exists (a P2P payee, a local shop like
 *      "THE CHENNAI SILKS") — regex genuinely has nothing to match.
 *   2. A pattern DOES exist but the category is ambiguous (Zerodha/Groww/
 *      etc. — regex knows WHO, not WHAT FOR; see smsParser.ts's
 *      TaxonomyEntry.ambiguous flag). custom_categories is what lets a
 *      user's one-time answer ("I mainly use Zerodha for stocks") override
 *      that ambiguous guess permanently, via matchCustomCategory() in
 *      smsParser.ts.
 *
 * NOT for the case registered_facts (Table X) handles — where the
 * merchant's IDENTITY itself is unrecoverable from the SMS (generic NACH
 * via a clearing house). This table always matches by merchant_key
 * directly; if there's no reliable merchant_key, this is the wrong table.
 */
import { supabase } from '../supabase';
import type { CustomCategoryEntry, TxnType } from '../smsParser';
import { normaliseMerchantKey } from '../smsParser';

async function getCurrentUserId(): Promise<string> {
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    throw new Error('Not authenticated — no user_id available for this request.');
  }
  return user.id;
}

// ─── Read ───────────────────────────────────────────────────────────────────

/**
 * Fetches every saved custom category for the current user, shaped exactly
 * as smsParser.ts's CustomCategoryEntry type expects. Call once per sync
 * batch, alongside fetchActiveRegisteredFacts() — both get passed into the
 * same MatchContext.
 */
export async function fetchCustomCategories(): Promise<CustomCategoryEntry[]> {
  const userId = await getCurrentUserId();
  const { data, error } = await supabase
    .from('custom_categories')
    .select('merchant_key, type, category, sub_category')
    .eq('user_id', userId);

  if (error) throw error;
  return (data ?? []) as CustomCategoryEntry[];
}

// [ADD] Display shape for the Custom Categories management screen
// (app/(app)/transactions/custom-categories.tsx) — was previously a
// one-line stub with no way to view saved mappings outside Supabase
// directly. Unlike fetchCustomCategories() above (which only selects the
// columns smsParser.ts's matcher needs), this also pulls `id` and the
// human-readable `merchant` string — needed so the screen can show a
// real name instead of a normalised key, and so deletion can target an
// exact row by id rather than re-deriving merchant_key from displayed
// text (which would only work if normaliseMerchantKey() is provably
// idempotent — safer to just not depend on that).
export interface CustomCategoryRow {
  id: string;
  merchant: string;
  merchant_key: string;
  type: TxnType;
  category: string;
  sub_category: string | null;
}

export async function fetchCustomCategoriesForDisplay(): Promise<CustomCategoryRow[]> {
  const userId = await getCurrentUserId();
  const { data, error } = await supabase
    .from('custom_categories')
    .select('id, merchant, merchant_key, type, category, sub_category')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });

  if (error) throw error;
  return (data ?? []) as CustomCategoryRow[];
}

// ─── Write ──────────────────────────────────────────────────────────────────

export interface SaveCustomCategoryInput {
  /** Raw merchant string exactly as extracted (e.g. "ZERODHA BROKING
   * LIMITED") — normalised internally before storage/matching. Kept as
   * `merchant` in the row too, for display purposes (see the merchant vs
   * merchant_key distinction — merchant is what a human reads, merchant_key
   * is what code compares). */
  merchant:      string;
  type:          TxnType;
  category:      string;
  subCategory:   string | null;
}

/**
 * Upsert on (user_id, merchant_key) — a user changing their mind about a
 * merchant's category (e.g. re-tagging Zerodha from "Stocks" to "Both,
 * mostly MF") should overwrite the existing row, not create a second,
 * contradictory one. This is exactly the failure mode the merchant_key
 * migration fixed — see the custom_categories schema discussion — so the
 * upsert target is deliberately merchant_key, not merchant.
 */
export async function saveCustomCategory(input: SaveCustomCategoryInput): Promise<void> {
  const userId = await getCurrentUserId();
  const merchantKey = normaliseMerchantKey(input.merchant);
  if (!merchantKey) {
    throw new Error(`saveCustomCategory: "${input.merchant}" normalised to an empty key — nothing to save against.`);
  }

  const { error } = await supabase
    .from('custom_categories')
    .upsert(
      {
        user_id:      userId,
        merchant:     input.merchant,
        merchant_key: merchantKey,
        type:         input.type,
        category:     input.category,
        sub_category: input.subCategory,
        updated_at:   new Date().toISOString(),
      },
      { onConflict: 'user_id,merchant_key' },
    );
  if (error) throw error;
}

/**
 * Convenience wrapper for the contextual-prompt flow (RegisterFactPrompt):
 * saves the custom category AND resolves the triggering transaction in one
 * action, matching confirmRegisteredFact()'s shape in registeredFacts.ts so
 * the UI layer can treat both paths uniformly.
 */
export async function confirmCustomCategory(
  txnId: string,
  input: SaveCustomCategoryInput,
): Promise<void> {
  await saveCustomCategory(input);

  const { error } = await supabase.from('transactions')
    .update({
      type:          input.type,
      category:      input.category,
      sub_category:  input.subCategory,
      status:        'approved',
      // [FIX] Mirrors registeredFacts.ts's confirmRegisteredFact — a
      // transaction smsParser.ts flagged parse_failure: 'unresolved_mandate'
      // (an unresolved NACH-mandate debit awaiting user classification) can
      // also be resolved via this path if the user saves a custom category
      // for the merchant instead of using the registered-fact prompt. Must
      // clear the marker here too, or the row stays flagged as unresolved
      // even after being fully categorized.
      parse_failure: null,
    })
    .eq('id', txnId);
  if (error) throw error;
}

/** For a "manage saved categories" settings screen, if one gets built —
 * lets a user remove a saved mapping so future transactions for that
 * merchant go back through normal classification (and the ambiguous-flag
 * review flow, if applicable) instead of auto-resolving. */
export async function deleteCustomCategory(merchant: string): Promise<void> {
  const userId = await getCurrentUserId();
  const merchantKey = normaliseMerchantKey(merchant);
  if (!merchantKey) return;

  const { error } = await supabase
    .from('custom_categories')
    .delete()
    .eq('user_id', userId)
    .eq('merchant_key', merchantKey);
  if (error) throw error;
}

// [ADD] Id-targeted delete for the management screen — see
// fetchCustomCategoriesForDisplay()'s comment for why this is safer than
// deleteCustomCategory(merchant) when working from already-fetched rows
// rather than a merchant string typed fresh into a form.
export async function deleteCustomCategoryById(id: string): Promise<void> {
  const userId = await getCurrentUserId();
  const { error } = await supabase
    .from('custom_categories')
    .delete()
    .eq('id', id)
    .eq('user_id', userId);
  if (error) throw error;
}