/**
 * src/lib/api/registeredFacts.ts
 *
 * Supabase read/write layer for registered_facts (Table X) — see
 * pileap_module_merchant_taxonomy.md and the conversation that designed
 * this table for full context. Solves the case custom_categories can't:
 * a NACH/mandate debit where the SMS itself cannot say who the money went
 * to (routes through a clearing-house name like "Indian Clearing Corp Ltd"
 * instead of the real lender/AMC/insurer).
 *
 * Two responsibilities:
 *   1. fetchActiveRegisteredFacts() — read side. Called ONCE per sync batch
 *      by the caller (test-sms.tsx today), then passed into
 *      parseSmsMessages() as part of MatchContext. smsParser.ts stays a
 *      pure function with no DB access of its own — this file is where
 *      that boundary is crossed, deliberately, on the outside.
 *   2. confirmRegisteredFact() — write side. Called when the user answers
 *      the contextual prompt (RegisterFactPrompt) for a pending_review NACH
 *      debit smsParser.ts couldn't resolve on its own. Does two things in
 *      one action: writes the new fact so every FUTURE matching debit
 *      resolves automatically, AND updates the transaction that triggered
 *      the prompt right now, so the user isn't left looking at an
 *      unresolved row after they just resolved it.
 *
 * MATCHING TOLERANCE — deliberately liberal, per project decision:
 *   - Amount: percentage-based (not a fixed rupee band), since EMI/SIP
 *     amounts genuinely shift (step-up SIPs, rate resets) — a fixed ₹50
 *     tolerance would be too brittle for a ₹50,000 EMI and too loose for a
 *     ₹200 one. Floored at a small fixed rupee amount so tiny facts still
 *     get SOME tolerance rather than requiring exact-paisa matches.
 *   - Day-of-month: ±5 days by default — NACH execution dates drift around
 *     bank holidays and weekends more than a tighter window would allow.
 * Both are stored per-fact (not hardcoded into the matcher), so an
 * individual fact can be tightened/loosened later without a code change —
 * see the `amount_tolerance`/`day_tolerance` columns.
 */
import { supabase } from '../supabase';
import type { RegisteredFact, TxnType } from '../smsParser';
// [ADD] Same normaliser custom_categories.ts uses, so both tables agree on
// what "the same merchant" means — see confirmRegisteredFact() below.
import { normaliseMerchantKey } from '../smsParser';

async function getCurrentUserId(): Promise<string> {
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    throw new Error('Not authenticated — no user_id available for this request.');
  }
  return user.id;
}

// Default tolerance policy — see header comment. Exported so the
// contextual-prompt UI can show the user what tolerance will be applied,
// rather than this being an invisible backend decision.
export const DEFAULT_AMOUNT_TOLERANCE_PCT = 0.15; // ±15%
export const MIN_AMOUNT_TOLERANCE = 50;            // floor, in rupees
export const DEFAULT_DAY_TOLERANCE = 5;            // ±5 days

function defaultAmountTolerance(amount: number): number {
  return Math.max(MIN_AMOUNT_TOLERANCE, Math.round(amount * DEFAULT_AMOUNT_TOLERANCE_PCT));
}

// ─── Read ───────────────────────────────────────────────────────────────────

/**
 * Fetches every active registered_facts row for the current user, shaped
 * exactly as smsParser.ts's RegisteredFact type expects. Call once per sync
 * batch, not once per message — matches the existing getCurrentUserId()
 * convention in transactions.ts (one auth round-trip per run, not per row).
 */
export async function fetchActiveRegisteredFacts(): Promise<RegisteredFact[]> {
  const userId = await getCurrentUserId();
  const { data, error } = await supabase
    .from('registered_facts')
    .select(`
      id,
      fact_type,
      reference_value,
      merchant_key,
      expected_amount,
      amount_tolerance,
      expected_day,
      day_tolerance,
      resolved_type,
      resolved_category,
      resolved_sub_category,
      is_secured_debt
    `)
    .eq('user_id', userId)
    .eq('is_active', true);

  if (error) throw error;
  return (data ?? []) as RegisteredFact[];
}

// ─── Write ──────────────────────────────────────────────────────────────────

export type FactType = 'emi' | 'sip' | 'insurance_premium' | 'salary';

export interface ConfirmRegisteredFactInput {
  /** The pending_review transaction row that triggered this prompt — gets
   * updated to the resolved category/type and moved out of pending_review
   * in the same action. */
  txnId:               string;
  factType:             FactType;
  /** Display name only (e.g. "Bajaj Finserv", "HDFC MF") — picked from a
   * dropdown in the UI, see registeredFactOptions.ts. Not used for
   * matching; matching is entirely amount/day/reference-based, per the
   * "we don't know what every entity looks like" design decision. */
  entityName:           string;
  amount:               number;
  /** YYYY-MM-DD, from the triggering transaction — used to derive
   * expected_day, never asked of the user directly. */
  txnDate:              string;
  /** [ADD] Raw merchant string from the triggering transaction (e.g.
   * "INDIAN CLEARING CORP LTD") — normalised here into merchant_key via
   * the same normaliseMerchantKey() custom_categories uses, so both
   * tables agree on "same merchant." Optional since a transaction could
   * in principle have merchant: null — in that case merchant_key is
   * stored null and this fact simply can't be matched via the
   * merchant_key tier later (falls through to reference_value-only
   * matching, or no match / pending_review — see matchRegisteredFact()
   * in smsParser.ts). */
  merchant?:            string | null;
  /** From the triggering transaction's extracted reference_value, if any
   * (UMRN/Mandate ID/Policy No/...). Passed through untouched — if present,
   * every future debit sharing this exact value resolves with certainty,
   * skipping the amount/day tolerance check entirely. */
  referenceValue?:      string | null;
  resolvedType:         TxnType;
  resolvedCategory:     string;
  resolvedSubCategory:  string | null;
  /** Only meaningful for loan-type facts — needed for the Debt Ratio
   * secured/unsecured weighting from the scoring reality-check doc.
   * Derived server-side from the chosen loan category in the UI, never
   * asked of the user as its own question. */
  isSecuredDebt?:       boolean | null;
}

function dayOfMonth(txnDate: string): number {
  return new Date(txnDate).getUTCDate();
}

/**
 * Writes a new registered_facts row AND resolves the triggering transaction
 * in one action. Deliberately two separate Supabase calls, not a single RPC
 * — see submitTransactionPage() in transactions.ts for the pattern this
 * codebase uses when true atomicity matters (a Postgres RPC). Not applied
 * here: if the fact insert succeeds but the transaction update fails (or
 * vice versa), the worst case is the user sees the same prompt again next
 * sync — annoying, not data-corrupting, since registered_facts rows are
 * idempotent-safe to have an extra one of (matching just picks the closest
 * fit). Revisit as an RPC if that assumption stops holding.
 */
export async function confirmRegisteredFact(input: ConfirmRegisteredFactInput): Promise<void> {
  const userId = await getCurrentUserId();
  // [ADD] Normalised the same way custom_categories.ts's saveCustomCategory()
  // does, so a registered fact and a custom category can never disagree on
  // what counts as "the same merchant."
  const merchantKey = normaliseMerchantKey(input.merchant ?? null);

  const { error: insertError } = await supabase.from('registered_facts').insert({
    user_id:                userId,
    fact_type:               input.factType,
    entity_name:             input.entityName,
    reference_value:         input.referenceValue ?? null,
    // [ADD] Primary Tier-2 matching signal in matchRegisteredFact() now,
    // alongside expected_amount — see smsParser.ts.
    merchant_key:            merchantKey,
    expected_amount:         input.amount,
    amount_tolerance:        defaultAmountTolerance(input.amount),
    expected_day:            dayOfMonth(input.txnDate),
    day_tolerance:           DEFAULT_DAY_TOLERANCE,
    resolved_type:           input.resolvedType,
    resolved_category:       input.resolvedCategory,
    resolved_sub_category:   input.resolvedSubCategory,
    // [FIX] Was declared on ConfirmRegisteredFactInput, documented as
    // needed for the Debt Ratio secured/unsecured weighting, and silently
    // never written. Null for non-EMI fact types, which is correct — the
    // column is only meaningful when fact_type === 'emi'.
    is_secured_debt:          input.isSecuredDebt ?? null,
    is_active:               true,
  });
  if (insertError) throw insertError;

  // [FIX-shaped note] status: 'approved', matching confirmContraPair()'s
  // convention in transactions.ts for "user just explicitly confirmed
  // this" — 'user_reviewed' is reserved for the History tab's distinct
  // terminal state (see useTransactionFeed.ts's buildFilters), not for a
  // fresh confirmation like this one.
  const { error: updateError } = await supabase.from('transactions')
    .update({
      type:          input.resolvedType,
      category:      input.resolvedCategory,
      sub_category:  input.resolvedSubCategory,
      status:        'approved',
      // [FIX] Was left untouched. smsParser.ts marks these rows
      // parse_failure: 'unresolved_mandate' precisely so health-module
      // scoring can skip them while type/category are withheld — now that
      // the user has supplied the real classification, the marker must be
      // cleared or the row stays permanently flagged as unresolved despite
      // being fully resolved.
      parse_failure: null,
    })
    .eq('id', input.txnId);
  if (updateError) throw updateError;
}

/**
 * "This isn't recurring anymore" — soft-deactivate rather than delete, so
 * historical transactions that were resolved via this fact keep a coherent
 * audit trail (nothing currently references registered_facts.id as a FK
 * from transactions, but is_active:false is the safer default regardless —
 * cheap to hide, expensive to reconstruct if deleted and needed later).
 */
export async function deactivateRegisteredFact(factId: string): Promise<void> {
  const userId = await getCurrentUserId();
  const { error } = await supabase
    .from('registered_facts')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', factId)
    .eq('user_id', userId); // belt-and-suspenders alongside RLS
  if (error) throw error;
}

/** For a settings/"manage recurring facts" screen, if one gets built later — not
 * currently wired to any UI, included for completeness since the table
 * supports it trivially. */
export async function fetchAllRegisteredFacts(): Promise<
  (RegisteredFact & { entity_name: string; is_active: boolean })[]
> {
  const userId = await getCurrentUserId();
  const { data, error } = await supabase
    .from('registered_facts')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as (RegisteredFact & { entity_name: string; is_active: boolean })[];
}