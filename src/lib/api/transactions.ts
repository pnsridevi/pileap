/**
 * src/lib/api/transactions.ts
 *
 * Supabase read/write layer for the transactions pipeline.
 * Consumes the output of smsParser.ts (ParsedTransaction | BalanceUpdate)
 * and routes each item to the correct table.
 *
 * Arch ref: Sections 5.3 (schema), 4.8 (pending_review triggers)
 *
 * KNOWN GAPS — flagged deliberately rather than silently worked around:
 *
 *   1. NO IDEMPOTENCY KEY on `transactions`. The arch doc calls for one per
 *      ingestion job, but the live schema has no column for it. Re-running
 *      ingestSmsMessages() on the same messages WILL create duplicate rows.
 *      [UPDATED — this pass] This is now a deliberate, visible consequence
 *      rather than a silent one: every re-sync of an overlapping window
 *      will re-flag the same set of SMS as possible duplicates (via
 *      possible_duplicate_of/pending_review) every single time, since there
 *      is still nothing to recognise "I've already seen this exact
 *      ingestion job." The user will see the same duplicate prompts again
 *      on every resync until an idempotency key exists. Still deferred, but
 *      now a real UX cost worth prioritising, not just a testing footnote.
 *
 *   2. [RESOLVED] merchant_key column migration has been applied, and
 *      smsParser.ts confirms it's a real, always-present field on
 *      ParsedTransaction — the insert below writes it directly.
 *
 *   3. raw_text is inserted in PLAINTEXT. Arch doc 11.2 requires AES-256
 *      encryption before insert. Not implemented here — flagging so this
 *      isn't mistaken for done. Do not ship to real users without this.
 *
 *   4. Account race condition: resolveAccountId() does a lookup-then-insert,
 *      not an atomic upsert, because there's no confirmed unique constraint
 *      on (user_id, account_number_masked) to upsert against. If two
 *      messages for a brand-new account are processed concurrently, this
 *      could create two account rows for the same account. Fine for
 *      sequential/on-device processing; revisit if ingestion ever runs
 *      concurrently (e.g. a backend worker).
 *
 *   5. Contra detection (runContraDetection, below) implements the arch doc
 *      5.7 three-tier model, but two things it references have no actual
 *      column to store them in: the literal note text ("possible
 *      infrastructure message", "matching transaction already reviewed")
 *      is never persisted — the UI is expected to derive these labels from
 *      possible_contra_of + the partner row's status/account_id instead.
 *      Flag if you'd rather add a real notes column.
 *
 *   6. Tier 1/2 matching takes the FIRST qualifying candidate when more than
 *      one exists (e.g. two same-day, same-amount transfers). The arch doc
 *      doesn't specify tie-breaking for that ambiguous case.
 *
 *   7. submitTransactionPage() below calls a Postgres RPC
 *      (submit_transaction_page — see supabase/migrations/) so the page
 *      Submit stays atomic per arch doc 5.3.3 ("Network failure during
 *      Submit -> Atomic rollback"). Confirm this RPC has been applied in
 *      every environment before relying on it — see PENDING_MIGRATIONS.md.
 *
 *   8. The "save this category for this merchant" checkbox in EditModal is
 *      UI-only right now — it captures intent in draft state but there's no
 *      call into a custom_categories API here, since that file wasn't in
 *      scope for this pass. Wire it up once custom_categories write
 *      functions exist.
 *
 *   9. resolveAccountId() infers account_type: 'credit_card' when
 *      smsParser.ts detected channel === 'Credit Card', else defaults to
 *      'bank' (arch doc 5.2 has no "unknown" enum value). Still imperfect:
 *      many real credit-card SMS never contain the literal words "credit
 *      card" and won't set that channel, so they'll still be mislabeled
 *      'bank'. loan/mf/equity/insurance/epf/nps/ppf/fd/real_estate are
 *      never inferred from SMS at all — those only ever get created
 *      correctly via the PDF-upload/manual-entry path (arch doc 5.2).
 *
 *  10. resolveUnknownAccountId() get-or-creates one placeholder "Unknown"
 *      account per user, for SMS with no extractable account number at all
 *      (arch doc Table 23 — account_id must never be null, even for
 *      pending_review rows).
 *
 *  11. [NEW — this pass] Duplicate detection is now entirely
 *      application-level, never silent. See DUPLICATE DETECTION section
 *      below. The DB's old (user_id, account_id, txn_date, amount) unique
 *      constraint has been dropped (see
 *      supabase/migrations/drop_duplicate_unique_constraint.sql) — it must
 *      no longer be relied on to reject anything, since every parsed
 *      message is now guaranteed to produce exactly one row. Confirm that
 *      migration has been applied in every environment before this
 *      behaves as designed — without it, exact-value true duplicates would
 *      go back to being silently rejected at the DB level regardless of
 *      what the application code does.
 *
 *  12. [NEW] findDuplicateCandidate() also compares merchant_key, not just
 *      (user_id, account_id, txn_date, amount). See the full comment on
 *      that function below for why, and why it uses a similarity ratio
 *      rather than exact string equality.
 *
 *  13. [NEW — this pass] runContraDetection() Tier 2/3 (and the
 *      user-reviewed-history fallback) now reuse that same merchant_key
 *      similarity check (isPlausiblySameMerchant()) before pairing two
 *      transactions as a possible internal transfer. Previously these
 *      tiers matched on account+amount+date alone, which meant two
 *      unrelated people's transactions with a coincidentally matching
 *      amount on the same day could get suggested as "internal transfer"
 *      regardless of plausibility. Tier 1 (ref_number match) is unchanged
 *      — that signal is already strong enough on its own.
 *
 *  14. [NEW — this pass] Bonds and Insurance premiums added to
 *      DEFINITIONAL_CONTRA_RULES alongside PPF/SSY — see that Set's
 *      comment below. Deliberately NOT extended to Mutual Funds/Stocks,
 *      since funding your own broker account is a genuine self-transfer.
 */

import { supabase } from '../supabase';
import type { ParsedTransaction, BalanceUpdate, Classification } from '../smsParser';
import { isBalanceUpdate, matchCustomCategory, matchRegisteredFact, normaliseMerchantKey } from '../smsParser';
// [ADD] Needed by reconcilePendingTransactions() below — same fetch
// functions test-sms.tsx already uses to build a MatchContext at parse
// time, reused here to re-check rows that were already inserted before a
// given custom category / registered fact existed.
import { fetchCustomCategories } from './customCategories';
import { fetchActiveRegisteredFacts } from './registeredFacts';
import { getSyncedSmsIds, markSmsIdsSynced } from '../syncedSmsCache';

// [CHANGED] Real login is now in place (phone/OTP via Supabase Auth). Every
// function that used to read the CURRENT_USER_ID constant now calls this
// helper instead, so each request is scoped to whoever is actually signed
// in — required for RLS policies (auth.uid() = user_id) to pass, and
// required now that multiple real users share this database.
async function getCurrentUserId(): Promise<string> {
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    throw new Error('Not authenticated — no user_id available for this request.');
  }
  return user.id;
}

// [REMOVED] UNKNOWN_ACCOUNT_SENTINEL — was only used by
// resolveUnknownAccountId(), also removed. See that removal's comment.

// ─── Account resolution ───────────────────────────────────────────────────────

async function resolveAccountId(
  accountNumberMasked: string | null,
  bank: string | null,
  channel: string | null | undefined,
  userId: string,
): Promise<string | null> {
  if (!accountNumberMasked) return null;

  const { data: existing, error: lookupError } = await supabase
    .from('accounts')
    .select('id')
    .eq('user_id', userId)
    .eq('account_number_masked', accountNumberMasked)
    .maybeSingle();

  if (lookupError) throw lookupError;
  if (existing) return existing.id;

  const accountType = channel === 'Credit Card' ? 'credit_card' : 'bank';

  const { data: created, error: insertError } = await supabase
    .from('accounts')
    .insert({
      user_id: userId,
      account_type: accountType,
      institution_name: bank,
      account_number_masked: accountNumberMasked,
      balance_latest: null,
      balance_updated_at: null,
      aa_linked: false,
      is_active: true,
    })
    .select('id')
    .single();

  if (insertError) throw insertError;
  return created.id;
}

// [REMOVED] resolveUnknownAccountId() and the UNKNOWN_ACCOUNT_SENTINEL
// get-or-create pattern. Previously every SMS with no extractable account
// number was routed to one shared "Unknown" account row per user — real
// impact found and fixed this session: findDuplicateCandidate() filters
// on account_id equality, so two completely unrelated transactions (from
// two different real bank accounts, both failing extraction) sharing the
// same date/amount/null-merchant would get flagged as duplicates of each
// other purely from being collapsed onto the same fake account_id. The
// fix is to make account_id genuinely nullable instead (see the
// drop_account_id_not_null migration) — null correctly means "we don't
// know," rather than a fake shared identity that looks like "we do know,
// and it's the same account for everyone." differentAccount() in
// runContraDetection() below already handles null account_id correctly
// with zero changes needed (see its comment) — this bug only existed
// because a non-null sentinel was being forced into a field designed to
// tolerate null. findDuplicateCandidate() below is updated to skip the
// account-based heuristic entirely when accountId is null, rather than
// trying to compare nulls (which SQL/PostgREST .eq() can't do reliably —
// same NULL-comparison class of bug this file already hit once with
// parse_failure, see fetchTransactions()'s comment on that).

// ─── Balance updates ──────────────────────────────────────────────────────────

async function applyBalanceUpdate(update: BalanceUpdate, userId: string): Promise<void> {
  if (!update.account_number_masked || update.balance === null) return;

  const accountId = await resolveAccountId(update.account_number_masked, update.bank, null, userId);
  if (!accountId) return;

  const { data: current, error: fetchError } = await supabase
    .from('accounts')
    .select('balance_updated_at')
    .eq('id', accountId)
    .single();

  if (fetchError) throw fetchError;

  const currentDate = current?.balance_updated_at
    ? String(current.balance_updated_at).slice(0, 10)
    : null;

  if (currentDate && update.message_date <= currentDate) {
    return;
  }

  const { error: updateError } = await supabase
    .from('accounts')
    .update({
      balance_latest: update.balance,
      balance_updated_at: update.message_date,
    })
    .eq('id', accountId);

  if (updateError) throw updateError;
}

// ─── Duplicate detection (application-level, replaces the dropped DB constraint) ──
//
// Product decision: a transaction must NEVER be silently rejected because it
// looks like a duplicate. Every parsed message always produces exactly one
// row. What used to be a hard DB unique constraint on (user_id, account_id,
// txn_date, amount) — silently dropping the insert — is now a pre-insert
// lookup that flags the new row (possible_duplicate_of, duplicate_confidence)
// and forces it to pending_review, so the user decides (confirmDuplicate /
// dismissDuplicate below) rather than the system guessing silently.
//
// Mirrors runContraDetection()'s two-phase search: active pool
// (pending_review/approved) first, then user_reviewed history as a
// fallback, since a duplicate of an already-reviewed row is just as real a
// duplicate as one still sitting in the active feed.
//
// [FIX — this pass] Previously matched on (user_id, account_id, txn_date,
// amount) ALONE — merchant was never even passed into this function, let
// alone compared. Two completely different people who happened to pay the
// same round amount on the same day (e.g. two ₹2,500 payments to unrelated
// merchants — confirmed on real data: Mr MATHIALAGAN K and JACOB K, same
// account, same date, same amount, no relation to each other) were
// unconditionally flagged as a possible duplicate and forced into
// pending_review.
//
// Fix: also compares merchant_key (already computed and stored on every
// row by smsParser.ts's normaliseMerchantKey() — no new normalisation
// logic needed here). Uses a SIMILARITY RATIO rather than exact equality,
// deliberately — exact-match would have been too strict: e.g.
// "shridevi.p.n@okicici" vs "SRI DEVI P N" is very likely the same real
// payee surfaced through two different SMS templates (the same squished-
// vs-spaced problem addressed throughout smsParser.ts's TAXONOMY fix), with
// merchant_keys that differ ("shridevipn@okicici" vs "sridevipn") despite
// probably being the same person. Similarity ratio correctly keeps that
// pair matchable (~0.67) while correctly excluding a genuinely different
// pair like mrmathialagank/jacobk (~0.20). Threshold of 0.5 is a first-pass
// value from real examples in this dataset — worth revisiting with more
// data. merchant_key === null on either side (can't discriminate at all —
// e.g. a NACH/mandate row with no clean merchant text) falls back to the
// original amount/date-only behaviour, since there's no information to
// safely rule the candidate out.

function merchantSimilarity(a: string, b: string): number {
  // Same algorithm family as difflib.SequenceMatcher.ratio(): 2 * matching
  // characters / (len(a) + len(b)), via longest-common-subsequence length
  // as the matching-characters proxy. Deliberately simple/dependency-free.
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const lcsLength = dp[a.length][b.length];
  return (2 * lcsLength) / (a.length + b.length);
}

const MERCHANT_SIMILARITY_THRESHOLD = 0.5;

// [NOTE — this pass] Reused directly by runContraDetection()'s Tier 2/3
// merchant-plausibility check further below, rather than introducing a
// second/separate similarity function for the same purpose.
function isPlausiblySameMerchant(a: string | null, b: string | null): boolean {
  if (!a || !b) return true; // can't discriminate -- don't rule the candidate out
  return merchantSimilarity(a, b) >= MERCHANT_SIMILARITY_THRESHOLD;
}

interface DuplicateCandidate {
  id: string;
  ref_number: string | null;
  // [ADD — this pass] Needed by computeDuplicateConfidence() below, so the
  // confidence score can reflect how close a merchant/person match actually
  // is, not just whether ref_number happened to match exactly.
  merchant_key: string | null;
}

async function findDuplicateCandidate(
  userId: string,
  accountId: string | null,
  txnDate: string,
  amount: number,
  merchantKey: string | null,
): Promise<DuplicateCandidate | null> {
  // [ADD] When the account is unresolved, skip this heuristic entirely
  // rather than trying to match it against other null-account rows. Two
  // reasons: (1) SQL's `= NULL` never matches, even against another NULL,
  // so a plain .eq('account_id', null) would silently find nothing anyway
  // — same NULL-comparison gotcha already documented elsewhere in this
  // file; (2) even a corrected null-to-null comparison would just
  // recreate the original bug — grouping every unresolved-account
  // transaction into one matching pool, which is exactly what caused
  // unrelated same-date/same-amount transactions to get flagged as
  // duplicates of each other. Real duplicate protection for these rows
  // still comes from findExistingTransactionForSms()'s exact raw_text
  // match (exactTextMatchId, checked independently before this function
  // is ever called) — and every unresolved-account row already forces
  // pending_review regardless (see the status computation below), so a
  // human reviews each one anyway.
  if (!accountId) return null;

  const { data: active, error: activeError } = await supabase
    .from('transactions')
    .select('id, ref_number, merchant_key')
    .eq('user_id', userId)
    .eq('account_id', accountId)
    .eq('txn_date', txnDate)
    .eq('amount', amount)
    .eq('is_deleted', false)
    .eq('is_contra', false)
    .in('status', ['pending_review', 'approved'])
    .order('created_at', { ascending: true });

  if (activeError) throw activeError;
  const activeMatch = (active ?? []).find(c => isPlausiblySameMerchant(merchantKey, c.merchant_key));
  if (activeMatch) return { id: activeMatch.id, ref_number: activeMatch.ref_number, merchant_key: activeMatch.merchant_key };

  const { data: history, error: historyError } = await supabase
    .from('transactions')
    .select('id, ref_number, merchant_key')
    .eq('user_id', userId)
    .eq('account_id', accountId)
    .eq('txn_date', txnDate)
    .eq('amount', amount)
    .eq('is_deleted', false)
    .eq('is_contra', false)
    .eq('status', 'user_reviewed')
    .order('created_at', { ascending: true });

  if (historyError) throw historyError;
  const historyMatch = (history ?? []).find(c => isPlausiblySameMerchant(merchantKey, c.merchant_key));
  return historyMatch ? { id: historyMatch.id, ref_number: historyMatch.ref_number, merchant_key: historyMatch.merchant_key } : null;
}

/**
 * Rough confidence signal for the UI, not a hard rule — the user always
 * confirms/dismisses regardless of this number, per product decision.
 * Same ref_number as the candidate (rare — usually means the same SMS
 * arrived twice) scores much higher than a same account/date/amount match
 * with a different or absent ref_number (plausibly two real, separate
 * transactions that just happen to share amount and date).
 *
 * [FIX — this pass] Previously ref_number match was the ONLY input — every
 * non-ref_number-match candidate scored the same flat 0.6, regardless of
 * whether the merchant/person was a near-exact match ("SRI DEVI P N" vs
 * "SRIDEVI P N") or barely cleared the plausibility bar. Now blends in the
 * actual merchant_key similarity ratio (the same one findDuplicateCandidate()
 * already used to gate whether this is even a candidate at all — see
 * isPlausiblySameMerchant()/MERCHANT_SIMILARITY_THRESHOLD above) so the
 * number reflects how close a match it really is, not just a binary flag.
 * Exact ref_number match still wins outright at 0.95 — a matching UPI
 * RRN/NEFT UTR is a stronger signal than name-similarity can ever be, since
 * it's a real system-assigned identifier, not a fuzzy text comparison.
 * When merchant_key is missing on either side, falls back to the original
 * flat 0.6 — there's no similarity signal to blend in at that point.
 */
function computeDuplicateConfidence(
  newRefNumber: string | null,
  candidateRefNumber: string | null,
  newMerchantKey: string | null,
  candidateMerchantKey: string | null,
): number {
  if (newRefNumber && candidateRefNumber && newRefNumber === candidateRefNumber) {
    return 0.95;
  }
  // [FIX — this pass] A confirmed MISMATCH is evidence, not silence.
  // Previously this fell through to the same merchant-similarity-based
  // score (0.6-0.9) whether ref numbers were absent entirely, or present
  // and genuinely different — treating "we don't know" and "we checked
  // and they're different" identically. Confirmed real-data false
  // positive: 4 separate IRCTC refunds routed through the same Cashfree
  // payout handle, same date/amount/merchant, each with a distinct real
  // ref_number, scored 0.9 (near-certain duplicate) purely from merchant-
  // name similarity — ignoring the one piece of hard evidence available
  // (their ref numbers) that they are NOT the same event. This doesn't
  // change WHETHER the row gets flagged for review — per the design note
  // above, that's still findDuplicateCandidate()'s call, and the user
  // always confirms/dismisses regardless. It only makes the displayed
  // confidence number honest: a mismatch pulls it BELOW the flat 0.6
  // fallback (rather than matching or exceeding it), since a checked and
  // confirmed non-match is stronger negative evidence than simply never
  // having a ref_number to check in the first place.
  if (newRefNumber && candidateRefNumber && newRefNumber !== candidateRefNumber) {
    return 0.3;
  }
  if (newMerchantKey && candidateMerchantKey) {
    const similarity = merchantSimilarity(newMerchantKey, candidateMerchantKey);
    // findDuplicateCandidate() already required similarity >=
    // MERCHANT_SIMILARITY_THRESHOLD before this candidate was even
    // returned, so this rescales that real range (threshold..1.0) into a
    // visible confidence range (0.6..0.9) — kept strictly below the 0.95
    // exact-ref_number ceiling above, since no reference number is ever a
    // weaker signal than an exact one.
    const scaled = (similarity - MERCHANT_SIMILARITY_THRESHOLD) / (1 - MERCHANT_SIMILARITY_THRESHOLD);
    return 0.6 + scaled * 0.3;
  }
  return 0.6;
}

// [FIX — this pass] crypto.randomUUID() is not guaranteed to exist in every
// runtime this app ships to — specifically, React Native/Hermes does not
// provide a global `crypto` object unless a polyfill (e.g.
// react-native-get-random-values) is explicitly installed. Without one,
// every call site below that used crypto.randomUUID() directly was
// throwing ("Property 'crypto' doesn't exist") at the exact moment a
// genuine Tier 1 (exact ref_number) contra match tried to persist —
// confirmed against real sync data: the 3 sync errors reported were
// precisely the 3 rows whose correct, exact-ref_number contra pairing
// should have succeeded. Since Tier 1's write never completes when this
// throws, those rows are left unmatched, and a LATER, weaker Tier 2/3
// match (which doesn't call crypto.randomUUID() at all, so it doesn't
// crash) can end up getting written instead — producing exactly the
// wrong-partner pairings seen in production (e.g. the Mohd Mustafa and
// Sridevi/PNB cases).
//
// generateGroupId() below prefers the native crypto.randomUUID() when it's
// actually available (real environments that do have it, e.g. web/Node),
// and falls back to a self-contained RFC 4122 v4 UUID generator when it
// isn't — so every call site gets a real, valid UUID either way, with no
// new dependency required and no behavior change in environments where
// crypto.randomUUID() already works fine.
function generateGroupId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ─── Transaction inserts ──────────────────────────────────────────────────────

// [FIX — this pass] Three changes, all confirmed against real data:
//
// 1. GENERIC_PPF_SSY REMOVED. A PPF/SSY contribution is an asset
//    acquisition (cash -> government scheme holding), not a transfer
//    between two of the user's own accounts — there is no offsetting
//    credit leg to ever find. It was being auto-marked is_contra with no
//    confirmation and no matched partner, which hid it from asset/
//    investment-rate tracking rather than correctly counting it. Its
//    existing type/category (Asset > Government Schemes > PPF/SSY) already
//    correctly identifies it and now stands on its own. Same reasoning as
//    the isPossibleSelfTransfer() fix in ruleset.js for broker funding —
//    see that file's comment for the fuller explanation.
//
// 2. GENERIC_BOND_PURCHASE and GENERIC_INSURANCE REMOVED. These rule IDs
//    were never actually defined in ruleset.js (confirmed by checking
//    every rule id in that file) — this membership was inert dead code.
//    They'd also be wrong to add back for the same reason as #1: bond
//    purchases and insurance premiums are asset/investment acquisitions,
//    not self-transfers.
//
// Kept as-is, out of scope for this pass: GENERIC_CC_PAYMENT, PLUXEE_CREDIT,
// NCMC_LOAD, CASH_DEPOSIT, WALLET_LOAD.
const DEFINITIONAL_CONTRA_RULES = new Set([
  'GENERIC_CC_PAYMENT',
  'PLUXEE_CREDIT',
  'NCMC_LOAD',
  'CASH_DEPOSIT',
  'WALLET_LOAD',
]);

// ─── Provisional credit reconciliation ─────────────────────────────────────
//
// Some vendor/broker messages describe money that hasn't landed in the bank
// account yet — a settlement "is processed" with no separate bank
// confirmation expected (VENDOR_SETTLEMENT_NOTICE), or an explicit future
// promise ("will be credited/refunded/processed" — PROVISIONAL_CREDIT_NOTICE,
// and the pre-existing REFUND_INITIATED). All three create a real,
// pending_review transaction row rather than being silently dropped — but
// they're PROVISIONAL: if and when the actual bank-side credit later
// arrives as its own separate SMS (an ordinary GENERIC_CREDIT etc.), the
// vendor's earlier placeholder becomes redundant and should disappear —
// "only the credit will appear," not both.
//
// Marked via parse_failure = 'awaiting_bank_confirmation' at insert time
// (see below) rather than a new column — parse_failure is already a
// free-text field used for several non-"failure" states (e.g.
// balance_disclosure_no_transaction), so this is consistent with existing
// usage, not a new pattern. No schema change.
// [FIX] Added PAYMENT_CONFIRMATION_NOTICE — this set (and this whole
// reconciliation mechanism) now covers vendor-side DEBIT confirmations
// too, not just credits. The name is kept as-is for continuity with the
// existing schema convention (parse_failure = 'awaiting_bank_confirmation'
// applies identically either direction), but see the amount!==0 guards
// below (previously amount>0-only) for the actual direction-agnostic fix.
const PROVISIONAL_CREDIT_RULES = new Set([
  'VENDOR_SETTLEMENT_NOTICE',
  'PROVISIONAL_CREDIT_NOTICE',
  'REFUND_INITIATED',
  'PAYMENT_CONFIRMATION_NOTICE',
]);

// How many days AFTER the provisional notice's own txn_date a later real
// credit is still considered its confirmation. IRCTC's own copy says
// "3-4 days"; broker settlements are typically faster (Zerodha: "within
// 24 hours"). One generous, single tunable constant rather than trying to
// parse each vendor's own stated timeframe out of free text — worth
// revisiting with more real data per the product decision to test broadly
// before tightening.
const PROVISIONAL_CREDIT_RECONCILE_WINDOW_DAYS = 15;

// Called for every REAL (non-provisional) credit being inserted. Looks for
// an earlier, still-outstanding provisional placeholder this credit could
// be confirming, and — if found — soft-deletes it (never a hard DELETE,
// same convention as confirmDuplicate() below) so only the real credit
// remains visible.
//
// Deliberately scoped by user_id ONLY, not account_id: the placeholder
// almost always has no extractable account number (vendors don't cite the
// receiving bank account) and resolves to the "Unknown" placeholder
// account, while the real confirming credit resolves to the actual bank
// account — those are different account_ids by construction, so matching
// on account_id would guarantee this never finds anything.
async function reconcileProvisionalCredit(
  userId: string,
  txnDate: string,
  amount: number,
): Promise<void> {
  const earliestDate = addDaysToDateString(txnDate, -PROVISIONAL_CREDIT_RECONCILE_WINDOW_DAYS);

  const { data: candidates, error } = await supabase
    .from('transactions')
    .select('id')
    .eq('user_id', userId)
    .eq('amount', amount)
    .eq('is_deleted', false)
    .eq('parse_failure', 'awaiting_bank_confirmation')
    .gte('txn_date', earliestDate)
    .lte('txn_date', txnDate)
    .order('created_at', { ascending: true })
    .limit(1);

  if (error) throw error;
  if (!candidates || candidates.length === 0) return;

  await supabase.from('transactions')
    .update({ is_deleted: true })
    .eq('id', candidates[0].id);
}

// [NEW] Reverse direction of the same problem. Ingestion processes
// messages in whatever order the input array is in — confirmed NOT
// guaranteed chronological (real device exports come back newest-first).
// That means the REAL credit can already exist in the database by the
// time its provisional placeholder is inserted — e.g. a Credit Alert
// dated 17-Feb gets processed before an IRCTC refund promise dated 16-Feb
// simply because it appears earlier in a newest-first array. Without this
// check, reconcileProvisionalCredit() above (which only looks BACKWARD
// from a new credit to an earlier placeholder) would never catch this
// case, and the placeholder would insert as a permanent, never-cleaned-up
// pending_review row. Called when inserting a provisional row itself, to
// decide whether it should already be considered resolved.
//
// KNOWN LIMITATION: this is a boolean existence check, not a consuming
// 1:1 pairing the way reconcileProvisionalCredit() above is (that one
// takes and removes exactly one candidate per call). If N provisional
// placeholders and M real credits share the same amount within the same
// window and N > M, every placeholder will independently see "yes, a
// qualifying credit exists" and all N will be marked resolved, even
// though only M were truly confirmed. Verified safe against the real
// ₹235 IRCTC/Cashfree cluster in this dataset (4 promises, 4 credits —
// counts match exactly), but flagging honestly: a mismatched-count case
// hasn't been tested and would currently over-resolve. Worth a proper
// consuming pair-up if this turns out to matter with more data.
async function findExistingConfirmingCredit(
  userId: string,
  txnDate: string,
  amount: number,
): Promise<boolean> {
  const latestDate = addDaysToDateString(txnDate, PROVISIONAL_CREDIT_RECONCILE_WINDOW_DAYS);

  const { data, error } = await supabase
    .from('transactions')
    .select('id')
    .eq('user_id', userId)
    .eq('amount', amount)
    .eq('is_deleted', false)
    .is('parse_failure', null)
    .gte('txn_date', txnDate)
    .lte('txn_date', latestDate)
    .limit(1);

  if (error) throw error;
  return !!(data && data.length > 0);
}

// [CHANGED — this pass] No longer a hard skip. Originally added to stop
// the same SMS being silently re-inserted (e.g. test-sms.tsx's sync button
// tapped twice), keyed on (user_id, raw_text, txn_date) since raw_sms_id
// was never persisted as a column. That protection is still needed — but
// a hard skip on this key has a real failure mode: two genuinely different
// real transactions can share byte-identical raw_text AND the same
// txn_date (confirmed against real data — two separate ₹1000 NACH SIP
// debits landing on the same day, with no time component in the SMS body
// to tell them apart), and a hard skip silently drops the second one with
// no row, no flag, nothing the user can see or correct.
//
// Now this signal feeds the SAME possible_duplicate_of/duplicate_confidence
// pipeline findDuplicateCandidate() already uses below — the row still
// gets inserted (never silently dropped, consistent with this file's
// existing "every parsed message always produces exactly one row"
// principle), just flagged and forced to pending_review so the user
// decides via confirmDuplicate()/dismissDuplicate(), instead of the app
// silently guessing either way.
//
// Scoped to is_deleted=false only — if an earlier row for this exact SMS
// was soft-deleted (e.g. as a resolved duplicate or reconciled
// placeholder), a fresh ingest of the same SMS should be allowed to
// re-insert clean rather than being flagged against a row nobody can see
// anymore.
async function findExistingTransactionForSms(
  userId: string,
  rawText: string,
  txnDate: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('transactions')
    .select('id')
    .eq('user_id', userId)
    .eq('raw_text', rawText)
    .eq('txn_date', txnDate)
    .eq('is_deleted', false)
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data ? data.id : null;
}

// [NEW] Cheap pre-filter for ingestParsedMessages(), NOT a replacement for
// findExistingTransactionForSms()'s exact-match check above. That check
// still runs on every row that passes this filter — this only skips rows
// that are so old they can't possibly be new, avoiding a DB round-trip per
// row for the (common, on every re-sync of an overlapping window) case of
// re-parsing days that were already fully synced.
//
// Deliberately >= the latest synced txn_date, not >: a message dated on the
// same calendar day as the latest synced row may still be genuinely new
// (e.g. a second purchase made later the same day, after the last sync
// ran) — SMS carry a date but this function only ever sees the DATE part,
// not the original time, so "same day" can't be assumed already-covered.
// Rows on that boundary day still go through the normal exact-match +
// duplicate-candidate pipeline in insertTransaction(); only strictly-older
// days are skipped outright here.
//
// Scoped to is_deleted=false, matching findExistingTransactionForSms()'s
// same scoping — a soft-deleted row (e.g. a resolved duplicate) shouldn't
// count as "already synced" for this purpose either.
async function getLatestSyncedTxnDate(userId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('transactions')
    .select('txn_date')
    .eq('user_id', userId)
    .eq('is_deleted', false)
    .order('txn_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data ? data.txn_date : null;
}

async function insertTransaction(txn: ParsedTransaction, userId: string): Promise<{ id: string; skipPairing: boolean }> {
  // [CHANGED — this pass] Still checked first, before any other work, but
  // no longer returns early — see findExistingTransactionForSms()'s
  // docblock above. Carried forward as exactTextMatchId and folded into
  // the duplicateCandidate/duplicateConfidence computation further down,
  // alongside findDuplicateCandidate()'s existing amount/date/merchant
  // heuristic.
  const exactTextMatchId = txn.raw_text
    ? await findExistingTransactionForSms(userId, txn.raw_text, txn.txn_date)
    : null;

  // [CHANGE] Previously fell back to resolveUnknownAccountId() (a shared
  // fake account per user) when no account number was extracted. Now
  // stays null — see the removal comment above resolveAccountId() for the
  // real bug this fixes. account_id is genuinely nullable on this table
  // now (see drop_account_id_not_null migration) — null means "we don't
  // know," and is handled correctly downstream by both contra detection
  // (differentAccount(), unchanged) and duplicate detection
  // (findDuplicateCandidate(), updated below to skip the account-based
  // check when accountId is null).
  const accountId = txn.account_number_masked
    ? await resolveAccountId(txn.account_number_masked, txn.bank, txn.channel, userId)
    : null;

  // [REMOVED] The "accountId must be non-null" guard that used to throw
  // here — no longer applicable now that null is a valid, expected value
  // for an unresolved account rather than an unreachable error state.

  // [FIX] Previously only checked matched_rule against DEFINITIONAL_CONTRA_RULES
  // — a hand-maintained list in THIS file. But smsParser.ts's ParsedTransaction
  // also carries txn.possible_contra, computed per-message by ruleset.js's
  // isPossibleSelfTransfer() (detects "IB FUNDS TRANSFER", "-TPT-" transfer
  // codes, PPF/SSY/NPS/RD/FD contributions, credit card bill payments, and
  // broker names like Zerodha/Groww/Upstox/IndMoney/Kuvera). That signal was
  // being computed and then silently discarded — confirmed against real
  // parser output: 13 real transactions (~₹5.1L of IB FUNDS TRANSFER/TPT
  // self-transfers and broker funding) were being counted as ordinary
  // income/expense because their matched_rule (GENERIC_CREDIT/GENERIC_DEBIT)
  // was never in DEFINITIONAL_CONTRA_RULES, even though possible_contra was
  // already true for every one of them. Now both signals are honored: a
  // named contra rule OR the message-level self-transfer detection.
  const isDefinitionalContra = !!(
    (txn.matched_rule && DEFINITIONAL_CONTRA_RULES.has(txn.matched_rule)) ||
    txn.possible_contra
  );

  const isProvisionalCredit = !!(txn.matched_rule && PROVISIONAL_CREDIT_RULES.has(txn.matched_rule));

  // [NEW] If this is a REAL (non-provisional) transaction, check whether
  // it confirms an earlier vendor promise/refund-initiated/payment-
  // confirmation placeholder still awaiting confirmation, and if so, hide
  // that placeholder now — "only the real transaction will appear," not
  // both. Must run before findDuplicateCandidate below: once the
  // placeholder is soft-deleted here, it's correctly excluded from that
  // query's is_deleted=false filter, so the two checks can't collide with
  // each other on the rare case they'd both match.
  // [FIX] Was `txn.amount > 0` (credit-only) — reconcileProvisionalCredit()
  // matches on exact signed amount equality, so it already worked
  // correctly for negative (debit) amounts once called; the guard just
  // never let a real debit call it. Broadened to amount!==0 now that
  // PAYMENT_CONFIRMATION_NOTICE (a debit-side placeholder, negative
  // amount) needs the same reconciliation a credit-side placeholder gets.
  if (!isProvisionalCredit && txn.amount !== null && txn.amount !== 0) {
    await reconcileProvisionalCredit(userId, txn.txn_date, txn.amount);
  }

  // [NEW] Reverse-direction check: if THIS row is itself a provisional
  // placeholder, the real confirming credit may already sit in the
  // database (see findExistingConfirmingCredit()'s comment for why —
  // processing order is not guaranteed chronological). If so, this
  // placeholder should be inserted already resolved.
  // [FIX] Same amount>0 → amount!==0 broadening as above, for the same
  // reason — a PAYMENT_CONFIRMATION_NOTICE placeholder has a negative
  // (debit) amount and needs this check to actually run for it.
  const alreadyConfirmed =
    (isProvisionalCredit && txn.amount !== null && txn.amount !== 0)
      ? await findExistingConfirmingCredit(userId, txn.txn_date, txn.amount)
      : false;

  // [NEW] Recurring-mandate exemption. NACH/ECS mandate debits routinely
  // produce multiple genuinely distinct transactions sharing account+date+
  // amount — e.g. two separate SIP contributions both debiting ₹1000 on
  // the same clearing day, or an EMI and an insurance premium mandate that
  // happen to both be ₹500 and both fall on the 5th. For this class,
  // "same account+date+amount" is the ROUTINE case, not suspicious — the
  // opposite of what findDuplicateCandidate() assumes for everything else.
  //
  // Deliberately kept SEPARATE from isDefinitionalContra/DEFINITIONAL_CONTRA_RULES
  // above rather than added to that set: that set also forces is_contra:true
  // on the row (see the insert payload below), which would be factually
  // wrong here — a NACH SIP debit is not a self-transfer/internal contra
  // pair, it's a real external payment. Reusing that set would misclassify
  // every NACH row as a contra transaction just to get the duplicate-skip
  // side effect.
  //
  // Generic by construction — keyed on structural signal (channel /
  // matched_rule) that already exists on every ParsedTransaction, never a
  // vendor/bank name. Applies identically to any bank's NACH mandate, any
  // vendor, any user. No schema change: channel and matched_rule are
  // already present on `txn` in memory at this point (see ParsedTransaction
  // in smsParser.ts) even though neither is persisted to the transactions
  // table by the INSERT below.
  const isRecurringMandate = txn.channel === 'NACH' || txn.matched_rule === 'GENERIC_NACH';

  // [CHANGED — this pass] Two duplicate signals now feed the same
  // possible_duplicate_of/duplicate_confidence pipeline:
  //   1. exactTextMatchId (from findExistingTransactionForSms above) — an
  //      identical raw_text + txn_date match. Takes priority when present,
  //      and deliberately applies even for recurring-mandate rows (unlike
  //      the heuristic check below) — a NACH SIP debit repeating on a
  //      DIFFERENT day is expected and fine, but two occurrences with
  //      byte-identical text on the SAME day is exactly the ambiguous case
  //      that needs a human decision, not a silent guess either way.
  //   2. findDuplicateCandidate() — the pre-existing amount+date+merchant
  //      heuristic, unchanged, still skipped for definitional-contra and
  //      recurring-mandate rows for the reasons already documented above.
  const duplicateCandidate: DuplicateCandidate | null = exactTextMatchId
    ? { id: exactTextMatchId, ref_number: null, merchant_key: null }
    : (!isDefinitionalContra && !isRecurringMandate && txn.amount !== null)
      ? await findDuplicateCandidate(userId, accountId, txn.txn_date, txn.amount, txn.merchant_key)
      : null;

  // [CHANGED — this pass] An identical raw_text + txn_date match is
  // stronger evidence than even an exact ref_number match (0.95) — it's
  // not just the same reference number, it's literally the same message
  // text end-to-end — so it's scored just above that ceiling.
  const duplicateConfidence = exactTextMatchId
    ? 0.98
    : duplicateCandidate
      ? computeDuplicateConfidence(txn.ref_number, duplicateCandidate.ref_number, txn.merchant_key, duplicateCandidate.merchant_key)
      : null;

  // [CHANGE — this pass] Was: "Per arch doc Table 23: account_id must not
  // be null" — that constraint has been deliberately overturned this
  // session (see resolveUnknownAccountId()'s removal comment above); a
  // missing account number is now represented as account_id: null
  // directly, not routed to a fake shared account. This line's actual
  // behavior is unchanged though: an unresolved account still forces
  // pending_review regardless of what the parser's own status said — that
  // safety rule was never really about account_id being non-null, it was
  // about a human needing to look at any row whose facts (which account?)
  // are uncertain. A possible duplicate ALSO forces pending_review,
  // regardless of what the parser said — duplicates are never
  // auto-approved, the user always decides.
  //
  // [FIX — this pass] Definitional contra rows now resolve to 'approved'
  // instead of falling through to txn.status. Previously, a genuine
  // self-transfer (e.g. IB FUNDS TRANSFER) still inherited pending_review
  // from needsReview's amount>=5000 check — a check that exists to catch
  // possibly-wrong facts, which is meaningless here since the row is
  // already confidently identified as a resolved internal transfer with
  // nothing left to correct. Confirmed on real data: 28/28 contra rows
  // >=Rs.5000 were stuck in pending_review forever with no code path that
  // ever cleared it, since being marked is_contra never used to touch
  // status at all. Still subordinate to the missing-account and duplicate
  // checks above — those are independent safety concerns this fix doesn't
  // touch.
  const status =
    !txn.account_number_masked || duplicateCandidate
      ? 'pending_review'
      : isDefinitionalContra
        ? 'approved'
        : txn.status;

  const { data, error } = await supabase.from('transactions').insert({
    user_id:               userId,
    account_id:            accountId,
    txn_date:              txn.txn_date,
    amount:                txn.amount,
    type:                  txn.type,
    category:              txn.category,
    sub_category:          txn.sub_category,
    merchant:              txn.merchant,
    merchant_key:          txn.merchant_key,
    source:                txn.source,
    status,
    raw_text:              txn.raw_text,
    // [FIX] Was never written — resolvedFrom made it as far as the in-memory
    // ParsedTransaction object and died there. See add_resolved_from.sql for
    // the column this now writes into, and the Transaction interface change
    // above for why the review queue UI can now actually read it back.
    resolved_from:         txn.resolvedFrom ?? null,
    // [NEW] Was always hardcoded false. A provisional-credit placeholder
    // whose real confirming credit already exists (see
    // findExistingConfirmingCredit() above) now inserts pre-resolved —
    // still a real row (never silently skipped, consistent with the
    // existing product decision that every parsed message always
    // produces exactly one row), just hidden from the start rather than
    // requiring a later UPDATE to hide it.
    is_deleted:            alreadyConfirmed,
    split_from_id:         null,
    added_late:            false,
    after_report_month:    null,
    is_contra:             isDefinitionalContra,
    possible_contra_of:    null,
    // [NEW — this pass] Was always null before. This is the entire point
    // of this pass: the row still gets inserted (never dropped), just
    // flagged when a duplicate candidate was found above.
    duplicate_confidence:  duplicateConfidence,
    possible_duplicate_of: duplicateCandidate?.id ?? null,
    health_module_tag:     txn.health_module_tag,
    ref_number:            txn.ref_number,
    ref_type:              txn.ref_type,
    txn_group_id:          null,
    is_infrastructure:     txn.is_infrastructure,
    // [FIX] parse_failure was computed on every ParsedTransaction
    // (buildDiscarded/buildEscalated set real reasons; the normal l2-match
    // path sets null) but was never actually included in this INSERT —
    // every discard/escalation reason was silently lost before reaching
    // the database. Independent, pre-existing gap; fixing it here because
    // the provisional-credit marking below now depends on this column
    // actually being written.
    // [NEW] Provisional-credit rows get a distinct marker here regardless
    // of what smsParser.ts set (always null for a successful l2 match,
    // provisional or not) — this is what reconcileProvisionalCredit()
    // above searches for later.
    parse_failure:         isProvisionalCredit ? 'awaiting_bank_confirmation' : txn.parse_failure,
  }).select('id').single();

  if (error) throw error;
  return { id: data.id, skipPairing: isDefinitionalContra };
}

// ─── Contra transaction detection (arch doc Section 5.7 — 3-tier model) ──────

function addDaysToDateString(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

interface TxnRow {
  id: string;
  user_id: string;
  account_id: string | null;
  txn_date: string;
  amount: number;
  // [ADD] Needed to exclude Income-type transactions (Salary, Refunds,
  // Passive Income, Dividends) from contra matching — see runContraDetection.
  type: string | null;
  ref_number: string | null;
  ref_type: string | null;
  status: string;
  is_infrastructure: boolean;
  is_contra: boolean;
  possible_contra_of: string | null;
  txn_group_id: string | null;
  // [ADD — this pass] Needed for merchant-plausibility discrimination on
  // Tier 2/3 contra matches — see isPlausiblySameMerchant() (defined above,
  // next to findDuplicateCandidate()) and its use in runContraDetection
  // below. Reuses that existing merchant_key similarity check rather than
  // introducing a second, separate one — same field, same threshold, same
  // conservative "no signal, don't discriminate" default. Tier 1
  // (ref_number match) doesn't need this; the ref_number match is already
  // strong enough on its own.
  merchant_key: string | null;
}

const TXN_SELECT_COLS =
  'id, user_id, account_id, txn_date, amount, type, ref_number, ref_type, status, is_infrastructure, is_contra, possible_contra_of, txn_group_id, merchant_key';

export async function runContraDetection(newTxnId: string, _depth = 0): Promise<void> {
  if (_depth > 5) return;

  const { data: txn, error: fetchError } = await supabase
    .from('transactions')
    .select(TXN_SELECT_COLS)
    .eq('id', newTxnId)
    .single<TxnRow>();

  if (fetchError) throw fetchError;
  if (!txn || txn.is_infrastructure || txn.is_contra) return;
  // [ADD] Income-type transactions (Salary, Refunds, Passive Income,
  // Dividends) represent money coming in from an external party — an
  // employer, a merchant refund, bank-paid interest, a company dividend —
  // never the user's own account. They should never be flagged as a
  // contra/transfer leg, even when the amount coincidentally matches an
  // unrelated debit. This matters specifically for refunds: the actual
  // reimbursed amount can legitimately differ from (or, worse,
  // coincidentally exactly equal) an unrelated debit, so amount-matching
  // a refund against anything is unreliable by nature on top of it not
  // being a self-transfer at all. Genuine self-transfer credits (e.g. "IB
  // FUNDS TRANSFER CR-...") are NOT typed 'Income' — they come out of
  // classify() as type: null (no taxonomy pattern matches that text) — so
  // this exclusion doesn't risk missing a real self-transfer.
  if (txn.type === 'Income') return;

  const dateFrom = addDaysToDateString(txn.txn_date, -1);
  const dateTo   = addDaysToDateString(txn.txn_date, 1);

  const { data: activeCandidates, error: activeError } = await supabase
    .from('transactions')
    .select(TXN_SELECT_COLS)
    .eq('user_id', txn.user_id)
    .eq('is_deleted', false)
    .eq('is_infrastructure', false)
    .eq('is_contra', false)
    .neq('id', txn.id)
    .eq('amount', -txn.amount)
    .gte('txn_date', dateFrom)
    .lte('txn_date', dateTo)
    .in('status', ['pending_review', 'approved'])
    // [ADD] Exclude Income-type candidates (Salary/Refunds/Passive
    // Income/Dividends) — see the guard above for the full reasoning.
    // Must use .or() with is.null, not a plain .neq(), for correct NULL
    // handling (genuine self-transfer credits are type: null and must
    // stay eligible).
    .or('type.is.null,type.neq.Income')
    .returns<TxnRow[]>();

  if (activeError) throw activeError;

  // [NOTE — this session] This already handles account_id: null correctly
  // with zero changes needed: if either side's account_id is null (falsy),
  // the whole expression short-circuits to `!false` = true, i.e. "treat
  // as different accounts, eligible for contra matching." That's the
  // right behavior — an unresolved account can't be proven to be the SAME
  // account as another transaction, so it shouldn't be excluded from
  // matching the way two confirmed-identical account_ids would be. This
  // only broke in practice when a fake shared "Unknown" account_id was
  // being forced into this field instead of a real null — see
  // resolveUnknownAccountId()'s removal comment near the top of this file.
  const differentAccount = (c: TxnRow) =>
    !(txn.account_id && c.account_id && txn.account_id === c.account_id);

  const eligible = (activeCandidates ?? []).filter(differentAccount);

  if (eligible.length > 0) {
    // Tier 1 stays merchant-agnostic — a matching ref_number (UPI RRN /
    // NEFT UTR) on both legs is already strong enough evidence on its own;
    // requiring merchant plausibility on top of it would only risk missing
    // real matches where one side's merchant field is a generic bank label
    // rather than a person/counterparty name.
    // [FIX] Added ref_type equality. Previously matched on ref_number
    // string equality alone — ref_number holds either a UPI RRN or a NEFT
    // UTR (see ref_type), two different numbering systems sharing one
    // column. Without also checking ref_type, an accidental collision
    // between an unrelated UPI RRN and NEFT UTR could auto-confirm a
    // contra match with zero user review (Tier 1 is the one tier that
    // applies immediately, no confirm/dismiss step) — exactly what
    // ref_type exists to prevent per arch doc 5.3.6 ("Prevents mismatching
    // UPI RRNs against NEFT UTRs in grouping logic").
    const tier1Match = eligible.find(c =>
      txn.account_id && c.account_id &&
      txn.ref_number && c.ref_number && txn.ref_number === c.ref_number &&
      txn.ref_type && c.ref_type && txn.ref_type === c.ref_type
    );
    if (tier1Match) { await applyContraMatch(txn, tier1Match, 'tier1', _depth); return; }

    // [FIX — this pass] Added isPlausiblySameMerchant() (the same
    // merchant_key similarity check findDuplicateCandidate() already uses
    // above, reused here rather than duplicated) to both Tier 2 and Tier 3.
    // Without it, "both accounts are known" (Tier 2) or "nothing better
    // exists" (Tier 3) was the entire bar for suggesting an internal
    // transfer — real example: two unrelated people's transactions
    // (different senders/recipients, same amount, same day, different
    // accounts) were getting suggested to the user as "internal transfer"
    // purely on coincidental amount match.
    const tier2Match = eligible.find(c =>
      txn.account_id && c.account_id &&
      isPlausiblySameMerchant(txn.merchant_key, c.merchant_key)
    );
    if (tier2Match) { await applyContraMatch(txn, tier2Match, 'tier2', _depth); return; }

    const tier3Match = eligible.find(c => isPlausiblySameMerchant(txn.merchant_key, c.merchant_key));
    if (tier3Match) { await applyContraMatch(txn, tier3Match, 'tier3', _depth); return; }

    return;
  }

  const { data: historyCandidates, error: historyError } = await supabase
    .from('transactions')
    .select(TXN_SELECT_COLS)
    .eq('user_id', txn.user_id)
    .eq('is_deleted', false)
    .eq('is_infrastructure', false)
    .eq('is_contra', false)
    .neq('id', txn.id)
    .eq('amount', -txn.amount)
    .gte('txn_date', dateFrom)
    .lte('txn_date', dateTo)
    .eq('status', 'user_reviewed')
    // [ADD] Same Income-type exclusion as the active-candidates query above.
    .or('type.is.null,type.neq.Income')
    .returns<TxnRow[]>();

  if (historyError) throw historyError;

  // [FIX — this pass] Same merchant-plausibility filter applied to the
  // user-reviewed-history fallback search, for the same reason as Tier
  // 2/3 above — a same-amount, same-day match against review history is
  // just as capable of being two unrelated people's transactions as a
  // match against the active pool is.
  const historyMatch = (historyCandidates ?? [])
    .filter(differentAccount)
    .find(c => isPlausiblySameMerchant(txn.merchant_key, c.merchant_key));
  if (historyMatch) {
    await applyContraMatch(txn, historyMatch, 'tier3', _depth);
  }
}

async function clearStaleLinkAndRecheck(staleRowId: string, depth: number): Promise<void> {
  await supabase.from('transactions').update({ possible_contra_of: null }).eq('id', staleRowId);
  await runContraDetection(staleRowId, depth + 1);
}

async function applyContraMatch(
  txn: TxnRow,
  partner: TxnRow,
  tier: 'tier1' | 'tier2' | 'tier3',
  depth: number,
): Promise<void> {
  if (partner.status === 'user_reviewed') {
    await supabase.from('transactions').update({
      status: 'pending_review',
      possible_contra_of: partner.id,
    }).eq('id', txn.id);
    return;
  }

  const txnStaleId     = (txn.possible_contra_of && txn.possible_contra_of !== partner.id) ? txn.possible_contra_of : null;
  const partnerStaleId = (partner.possible_contra_of && partner.possible_contra_of !== txn.id) ? partner.possible_contra_of : null;

  if (tier === 'tier1') {
    // [FIX — this pass] Tier 1 is an exact ref_number+ref_type match — the
    // same strength of evidence as a definitional rule, auto-applied with
    // no user confirmation. It should resolve status the same way the
    // insert-time definitional fix does, for the same reason: nothing is
    // left to correct once both legs are confidently linked. Never
    // downgrades an already-'user_reviewed' row back to 'approved'.
    const groupId = partner.txn_group_id || txn.txn_group_id || generateGroupId();
    const txnNewStatus     = txn.status === 'user_reviewed'     ? txn.status     : 'approved';
    const partnerNewStatus = partner.status === 'user_reviewed' ? partner.status : 'approved';
    await supabase.from('transactions').update({ is_contra: true, txn_group_id: groupId, possible_contra_of: null, status: txnNewStatus }).eq('id', txn.id);
    await supabase.from('transactions').update({ is_contra: true, txn_group_id: groupId, possible_contra_of: null, status: partnerNewStatus }).eq('id', partner.id);

    if (txn.ref_number) {
      await supabase
        .from('transactions')
        .update({ txn_group_id: groupId })
        .eq('user_id', txn.user_id)
        .eq('ref_number', txn.ref_number)
        .eq('is_infrastructure', true);
    }
  } else {
    await supabase.from('transactions').update({ possible_contra_of: partner.id }).eq('id', txn.id);
    await supabase.from('transactions').update({ possible_contra_of: txn.id }).eq('id', partner.id);
  }

  if (txnStaleId)     await clearStaleLinkAndRecheck(txnStaleId, depth);
  if (partnerStaleId) await clearStaleLinkAndRecheck(partnerStaleId, depth);
}

// ─── Main ingestion entry point ───────────────────────────────────────────────

function getErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
    return (e as { message: string }).message;
  }
  return String(e);
}

export interface IngestResult {
  transactionsInserted: number;
  balancesUpdated: number;
  /** [CHANGED — this pass] No longer possible for this to be nonzero from
   * the DB unique constraint, since that constraint is dropped. Kept at 0
   * always now — retained in the type only so callers/UI reading this
   * field don't break. Use duplicatesFlagged (below) instead, which is the
   * real, non-silent replacement: every parsed message is inserted, this
   * just tells you how many were flagged for the user to review. */
  duplicatesSkipped: number;
  /** [NEW — this pass] Count of transactions inserted THIS run with
   * possible_duplicate_of set — i.e. flagged for the user, not dropped.
   * This is expected to be nonzero on every re-sync of an overlapping
   * window until Known Gap #1 (no idempotency key) is fixed — that's a
   * real, visible consequence of that gap, not evidence of a new bug. */
  duplicatesFlagged: number;
  /** [NEW] Count of items skipped outright because their txn_date fell
   * strictly before the latest already-synced txn_date for this user — see
   * getLatestSyncedTxnDate()'s comment for why this is a >= cutoff, not a
   * hard guarantee of no duplicates on the boundary day itself. This is
   * purely a network-cost optimization; correctness still comes from
   * insertTransaction()'s per-row exact-match + duplicate-candidate checks
   * on whatever remains after this filter. */
  skippedBeforeLastSync: number;
  /** [ADD] Count of items skipped because this device's local synced-IDs
   * cache (syncedSmsCache.ts) already recognizes their raw_sms_id from an
   * earlier run — see that file's docblock for exactly what this does and
   * doesn't protect against. These never reach insertTransaction() at
   * all, so unlike duplicatesFlagged, they never create a row and never
   * need manual review — this is what actually fixes the "crash mid-sync,
   * retry floods the review queue" problem. */
  skippedAlreadySynced: number;
  errors: { raw_sms_id: string; message: string }[];
}

/** [ADD] Optional progress callback — invoked after each chunk completes
 * with how many of itemsToProcess have been attempted so far. Purely for
 * UI ("340/600 synced"); ingestParsedMessages() behaves identically
 * whether or not a caller passes this. */
export type IngestProgressCallback = (processed: number, total: number) => void;

// [ADD] Chunk size for the main sync loop below — see the chunking
// discussion this was built from. Kept as a named constant rather than a
// magic number so it's one obvious place to tune if real-world timing
// data later suggests a different size.
const SYNC_CHUNK_SIZE = 25;

export async function ingestParsedMessages(
  items: (ParsedTransaction | BalanceUpdate)[],
  onProgress?: IngestProgressCallback,
): Promise<IngestResult> {
  // [CHANGED] Fetched ONCE per sync run, not once per message. Each of these
  // was previously an independent supabase.auth.getUser() call — which
  // always makes a real network round-trip to revalidate with the Auth
  // server, not just a local read. For a 90-day window with dozens/hundreds
  // of parsed SMS, that was one network call per row before any actual
  // insert happened. Fetching once here and threading it through
  // insertTransaction()/applyBalanceUpdate() below removes that entirely.
  const userId = await getCurrentUserId();

  const result: IngestResult = {
    transactionsInserted: 0,
    balancesUpdated: 0,
    duplicatesSkipped: 0,
    duplicatesFlagged: 0,
    skippedBeforeLastSync: 0,
    skippedAlreadySynced: 0,
    errors: [],
  };

  // [NEW] Skip re-processing days that are already fully synced. Balance
  // updates are exempt — applyBalanceUpdate() already self-guards on
  // update.message_date vs the account's current balance_updated_at, so
  // there's no cost/correctness reason to filter those here too, and doing
  // so would risk skipping a legitimate balance refresh.
  const latestSyncedDate = await getLatestSyncedTxnDate(userId);
  const afterDateFilter = latestSyncedDate
    ? items.filter((item) => isBalanceUpdate(item) || item.txn_date >= latestSyncedDate)
    : items;
  result.skippedBeforeLastSync = items.length - afterDateFilter.length;

  // [ADD] Skip messages this device already knows it successfully synced —
  // see syncedSmsCache.ts for exactly what this does and doesn't protect
  // against. Deliberately a SEPARATE, additional filter from the date-based
  // one above, not a replacement for it: the date filter is a cheap
  // day-level pre-filter that runs regardless of this cache's state (e.g.
  // still helps on a brand new device with an empty cache but existing
  // server data), while this one is what actually closes the crash-retry
  // gap within the boundary day itself.
  const syncedIds = await getSyncedSmsIds(userId);
  const itemsToProcess = afterDateFilter.filter((item) => !syncedIds.has(item.raw_sms_id));
  result.skippedAlreadySynced = afterDateFilter.length - itemsToProcess.length;

  // [CHANGED — this pass] Chunked instead of one continuous loop over every
  // item. Each chunk's successfully-processed raw_sms_ids are written to
  // the local cache as soon as that chunk finishes — not just once at the
  // very end — so if the app is killed between chunks, everything up to
  // the last completed chunk is protected on the next run; only the
  // in-flight chunk at the moment of the crash is ever re-attempted.
  for (let chunkStart = 0; chunkStart < itemsToProcess.length; chunkStart += SYNC_CHUNK_SIZE) {
    const chunk = itemsToProcess.slice(chunkStart, chunkStart + SYNC_CHUNK_SIZE);
    const succeededIdsThisChunk: string[] = [];

    for (const item of chunk) {
      try {
        if (isBalanceUpdate(item)) {
          await applyBalanceUpdate(item, userId);
          result.balancesUpdated++;
        } else {
          const { id: newId, skipPairing } = await insertTransaction(item, userId);
          result.transactionsInserted++;

          // [NEW — this pass] Every insert now succeeds (no more silent
          // DB-level rejection), so check afterward whether it was flagged as
          // a possible duplicate, purely for the summary count.
          const { data: inserted, error: fetchErr } = await supabase
            .from('transactions')
            .select('possible_duplicate_of')
            .eq('id', newId)
            .single();
          if (!fetchErr && inserted?.possible_duplicate_of) {
            result.duplicatesFlagged++;
          }

          if (!skipPairing) await runContraDetection(newId);
        }
        // [ADD] Only mark as synced on genuine success — an item that
        // threw must NOT be cached, or a persistently-failing message
        // (e.g. a real server error) would silently never be retried.
        succeededIdsThisChunk.push(item.raw_sms_id);
      } catch (e) {
        result.errors.push({
          raw_sms_id: item.raw_sms_id,
          message: getErrorMessage(e),
        });
      }
    }

    // [ADD] Persist this chunk's progress before moving to the next one —
    // see the chunk-loop comment above for why this is what actually makes
    // a crash between chunks safe to resume from.
    await markSmsIdsSynced(userId, succeededIdsThisChunk);

    const processedSoFar = Math.min(chunkStart + SYNC_CHUNK_SIZE, itemsToProcess.length);
    onProgress?.(processedSoFar, itemsToProcess.length);

    // Yield to the UI thread between chunks (was: every 10 items inside one
    // continuous loop). Chunk-level yielding is coarser but the loop itself
    // is now bounded in size per chunk, so total time-without-yielding per
    // chunk stays comparable to before while chunk boundaries also double
    // as the cache-persistence points above.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return result;
}

// ─── Fetch for the Transactions tab ───────────────────────────────────────────

export interface TransactionFilters {
  // [FIX] Added 'haiku_suggested' — a real, live status value in the DB
  // CHECK constraint (transactions_status_check) that was absent from
  // every TypeScript type in this file. Concretely: fetchTransactions()'s
  // caller (Transactions tab) only ever requested
  // statuses: ['pending_review', 'approved'] — a row the backend Haiku
  // worker (layer3_haiku.js — still unopened, per the original
  // carry-forward notes) sets to 'haiku_suggested' would match NONE of the
  // app's queries: not the active feed, not history (user_reviewed only).
  // It would be permanently invisible with no error anywhere. This fix
  // only restores the type — see fetchTransactions()/fetchNeedsReviewCount()
  // below and index.tsx for the query-level fix that actually includes it.
  status?:  'approved' | 'pending_review' | 'user_reviewed' | 'haiku_suggested';
  statuses?: ('approved' | 'pending_review' | 'user_reviewed' | 'haiku_suggested')[];
  category?: string;
  page?:     number;
  pageSize?: number;
}

export async function fetchTransactions(filters: TransactionFilters = {}) {
  const { status, statuses, category, page = 0, pageSize = 20 } = filters;
  const userId = await getCurrentUserId();

  // [ADD] Embeds the related `accounts` row (via the account_id FK) in the
  // same query, rather than a separate fetchAccounts() call merged
  // client-side. This is a single Postgres-side join — still one network
  // round trip, and `accounts` is a tiny per-user table (a handful of rows
  // at most), so this adds negligible cost even at pageSize=20. Only the
  // two fields the UI actually needs (last-4 display) are selected, not
  // the full accounts row.
  let query = supabase
    .from('transactions')
    .select('*, accounts(account_number_masked, institution_name)', { count: 'exact' })
    .eq('user_id', userId)
    .eq('is_deleted', false)
    // [ADD] Exclude declined-transaction placeholders (buildDiscarded in
    // smsParser.ts — parse_failure: 'declined_transaction', amount always
    // null) from the main ledger. No money moved, so these don't belong
    // mixed into "N transactions this month" or a review queue that exists
    // to correct amount/category/merchant — a decline has none of those to
    // correct. Confirmed against real data: 4 such rows (2 decline events,
    // double-sent by the bank) rendered as identical, indistinguishable
    // "Uncategorized +₹0.00" rows before this — see TransactionRow.tsx fix.
    // Row is NOT deleted — still exists in the DB for fraud-signal/audit
    // purposes per the "never silently drop a parsed message" principle —
    // just excluded from this feed specifically.
    //
    // [IMPORTANT] Must use .or() with an explicit is.null branch, NOT a
    // plain .neq('parse_failure', 'declined_transaction'). Postgres's <>
    // comparison against a NULL parse_failure (true for the vast majority
    // of real, non-discarded transactions) evaluates to NULL, not TRUE —
    // and a WHERE clause treats NULL as "exclude." A bare .neq() here would
    // have silently filtered out every normal transaction, not just
    // declined ones.
    .or('parse_failure.is.null,parse_failure.neq.declined_transaction')
    .order('txn_date', { ascending: false })
    // [FIX] Real bug found this session: ordering by txn_date alone is
    // NOT deterministic across separate paginated queries when multiple
    // rows share the same txn_date (common — most days have several
    // transactions). Postgres doesn't guarantee stable ordering for tied
    // rows between independent range()-limited queries, so a tied row
    // near a page boundary could fall into the gap between two pages'
    // windows and never appear on ANY page — while total count() stayed
    // accurate, since counting doesn't care about row order. Confirmed
    // against real data: a transaction was reachable via a direct SQL
    // query and correctly included in the 82-row count, but never
    // appeared across all 5 paginated UI pages. Adding `id` (always
    // unique) as a secondary sort key makes the order fully deterministic
    // — same page contents every time, no gaps, no duplicates.
    .order('id', { ascending: true })
    .range(page * pageSize, page * pageSize + pageSize - 1);

  if (statuses && statuses.length > 0) {
    query = query.in('status', statuses);
  } else if (status) {
    query = query.eq('status', status);
  }
  if (category) query = query.eq('category', category);

  const { data, error, count } = await query;
  if (error) throw error;

  return { transactions: (data ?? []) as Transaction[], totalCount: count ?? 0 };
}

// ─── Full row type for the Transactions tab (arch doc 5.3.6) ─────────────────

export interface Transaction {
  id: string;
  user_id: string;
  account_id: string | null;
  // [ADD] Populated only by fetchTransactions()'s embedded accounts join
  // above — null for any Transaction obtained another way (e.g.
  // insertManualTransaction()'s return value, which only selects `id`).
  // Kept as a nested object matching Supabase's embed shape 1:1, rather
  // than flattened onto the top level, so it's visually obvious at every
  // call site that this came from a join, not a real transactions column.
  accounts: { account_number_masked: string | null; institution_name: string | null } | null;
  txn_date: string;
  // [FIX] Was `number` — wrong. insertTransaction() writes `amount: txn.amount`
  // straight from ParsedTransaction, which is `number | null` (buildDiscarded/
  // buildEscalated intentionally insert null for declined-transaction
  // placeholders — see transactions.ts INSERT payload above). The old
  // non-nullable type let TransactionRow's mapTransactionToRow() call
  // Math.abs(txn.amount) on a null value without the type checker ever
  // flagging it — Math.abs(null) silently coerces to 0, which is the root
  // cause of declined transactions rendering as "+₹0.00" (a false, misleading
  // credit) instead of being recognized as "no amount to show." Fixed at the
  // source (this type) and at the point of use (TransactionRow.tsx).
  amount: number | null;
  // [FIX] Same issue — insertTransaction() writes `type: txn.type` and
  // `category: txn.category`, both `| null` on ParsedTransaction
  // (classification is genuinely absent for many real rows: P2P transfers,
  // declined placeholders, anything classify() didn't match). Widened to
  // match reality.
  type: 'Expense' | 'Income' | 'Investment' | 'Liability' | 'Asset' | null;
  category: string | null;
  sub_category: string | null;
  merchant: string | null;
  merchant_key: string | null;
  source: 'sms' | 'email' | 'manual' | 'pdf' | 'cash' | 'haiku';
  status: 'pending_review' | 'approved' | 'user_reviewed' | 'haiku_suggested';
  reviewed_at: string | null;
  raw_text: string | null;
  // [ADD] Was computed at parse time (smsParser.ts's Classification.
  // resolvedFrom) but never persisted — insertTransaction() never wrote it
  // and this table had no column for it. See add_resolved_from.sql. Needed
  // so the review queue UI can show "matched from your saved preference"
  // vs "matched from a registered recurring payment" instead of nothing.
  resolved_from: 'custom_category' | 'registered_fact' | null;
  is_deleted: boolean;
  split_from_id: string | null;
  added_late: boolean;
  after_report_month: string | null;
  is_contra: boolean;
  possible_contra_of: string | null;
  duplicate_confidence: number | null;
  possible_duplicate_of: string | null;
  health_module_tag: string[] | null;
  ref_number: string | null;
  ref_type: 'upi_rrn' | 'neft_utr' | 'unknown' | null;
  txn_group_id: string | null;
  is_infrastructure: boolean;
  created_at: string;
  // [FIX] Was missing from this interface despite being a real column,
  // actively queried elsewhere in this file (.eq('parse_failure',
  // 'awaiting_bank_confirmation'), .is('parse_failure', null)) and written
  // on insert. select('*') was already returning it at runtime; it just
  // wasn't typed, so nothing could read it safely. Free-text field used for
  // several distinct "flagged, needs special handling" states — see the
  // header comment above confirmProvisionalCredit's usage — not only
  // parse failures despite the name.
  parse_failure: string | null;
}

export async function fetchTransactionById(id: string): Promise<Transaction | null> {
  // [CHANGED] Explicit user_id filter added here as defense-in-depth. RLS
  // (auth.uid() = user_id) already prevents this from returning another
  // user's row, but filtering explicitly too keeps this function's
  // behaviour correct even if RLS is ever temporarily disabled for
  // debugging (see earlier note: RLS doesn't block dashboard/service-role
  // access, so it's safe to keep this belt-and-braces check).
  const userId = await getCurrentUserId();
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return (data as Transaction | null) ?? null;
}

// ─── Counts for banners / empty states (arch doc 5.3.5) ──────────────────────

export async function fetchNeedsReviewCount(): Promise<number> {
  const userId = await getCurrentUserId();
  const { count, error } = await supabase
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('is_deleted', false)
    // [FIX] Was .eq('status', 'pending_review') only — haiku_suggested rows
    // need the user's attention just as much (a Haiku-suggested guess is
    // exactly the kind of thing that should show up in "N need review"),
    // and were silently excluded from the count entirely.
    .in('status', ['pending_review', 'haiku_suggested'])
    // [ADD] Same exclusion as fetchTransactions above, same reason: a
    // declined-transaction placeholder has no amount/category/merchant to
    // correct, so it shouldn't inflate "N need review" with something the
    // user can't actually act on. Same NULL-semantics caveat applies — see
    // the comment in fetchTransactions for why this can't be a plain .neq().
    .or('parse_failure.is.null,parse_failure.neq.declined_transaction');

  if (error) throw error;
  return count ?? 0;
}

export async function hasAnyTransactions(): Promise<boolean> {
  const userId = await getCurrentUserId();
  const { count, error } = await supabase
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);

  if (error) throw error;
  return (count ?? 0) > 0;
}

// ─── Contra confirmation (Tier 2/3 matches need explicit user confirmation) ──

export async function confirmContraPair(txnId: string, partnerId: string): Promise<void> {
  const groupId = generateGroupId();
  // [FIX — this pass] Confirming a Tier 2/3 suggestion is a genuine human
  // review — same standard as any other manual approval. Previously
  // is_contra was set but status was left untouched, so a row that needed
  // pending_review (e.g. amount>=5000) stayed stuck there forever even
  // after the user explicitly confirmed it.
  await supabase.from('transactions')
    .update({ is_contra: true, txn_group_id: groupId, possible_contra_of: null, status: 'approved' })
    .eq('id', txnId);
  await supabase.from('transactions')
    .update({ is_contra: true, txn_group_id: groupId, possible_contra_of: null, status: 'approved' })
    .eq('id', partnerId);
}

// [FIX — this pass] Previously only updated the incoming txnId, never the
// already-user_reviewed partner it was matched against — so confirming a
// "possible internal transfer" against reviewed history left the OLD row
// completely untouched: no is_contra, no shared txn_group_id. The person
// taps Confirm, only one side of the transfer actually gets marked.
// Fixed by reading the stored possible_contra_of FK (already pointing at
// the reviewed partner — set by runContraDetection()'s post-review
// branch) and updating both rows with the same generated group id, same
// pattern confirmContraPair() above already uses for the two-new-rows case.
export async function confirmContraAgainstHistoryMatch(txnId: string): Promise<void> {
  const { data: txn, error: fetchError } = await supabase
    .from('transactions')
    .select('possible_contra_of')
    .eq('id', txnId)
    .single();
  if (fetchError) throw fetchError;

  const groupId = generateGroupId();
  // [FIX — this pass] Same status fix as confirmContraPair() above, for
  // the new (txnId) row. The partner is deliberately NOT given a status
  // update here — it's already 'user_reviewed' by definition of this
  // function's own name, and that must not be downgraded back to
  // 'approved'.
  await supabase.from('transactions')
    .update({ is_contra: true, txn_group_id: groupId, possible_contra_of: null, status: 'approved' })
    .eq('id', txnId);

  if (txn?.possible_contra_of) {
    await supabase.from('transactions')
      .update({ is_contra: true, txn_group_id: groupId, possible_contra_of: null })
      .eq('id', txn.possible_contra_of);
  }
}

export async function dismissContraPair(txnId: string): Promise<void> {
  const { data: txn, error } = await supabase
    .from('transactions')
    .select('possible_contra_of')
    .eq('id', txnId)
    .single();
  if (error) throw error;

  // [FIX — this pass] Mirrors dismissDuplicate()'s existing pattern below:
  // a human has now explicitly looked at this and said it's NOT a
  // transfer, which is itself a completed review, same as confirming one.
  await supabase.from('transactions').update({ possible_contra_of: null, status: 'approved' }).eq('id', txnId);
  if (txn?.possible_contra_of) {
    await supabase.from('transactions').update({ possible_contra_of: null, status: 'approved' }).eq('id', txn.possible_contra_of);
  }
}

// ─── Duplicate confirmation (mirrors the contra confirm/dismiss pattern) ─────
//
// insertTransaction() (above) sets possible_duplicate_of/duplicate_confidence
// and forces pending_review whenever a possible duplicate is found — never a
// silent drop. These are what the Transactions tab calls when the user taps
// "Yes, duplicate" / "No, keep both" on that prompt.

/**
 * User confirmed this row IS a duplicate of an existing one. This is the
 * first real caller of soft-delete (is_deleted=true) in this file — the
 * general-purpose "delete any transaction" UI control discussed separately
 * is still not built (see PENDING_MIGRATIONS.md), but this is the same
 * underlying mechanism, scoped to the one case that's actually wired up
 * end-to-end right now. Never a hard DELETE — health-score/goals
 * calculations must still be able to trust is_deleted rather than rows
 * actually vanishing.
 */
export async function confirmDuplicate(txnId: string): Promise<void> {
  await supabase.from('transactions')
    .update({ is_deleted: true })
    .eq('id', txnId);
}

/**
 * User said these are two separate, real transactions — clears the flag
 * and approves the row, since a human has now explicitly looked at it.
 */
export async function dismissDuplicate(txnId: string): Promise<void> {
  await supabase.from('transactions')
    .update({
      possible_duplicate_of: null,
      duplicate_confidence: null,
      status: 'approved',
    })
    .eq('id', txnId);
}

// ─── Page Submit (draft workspace -> DB, arch doc 5.3.3) ──────────────────────

export interface TransactionEdit {
  id: string;
  txn_date?: string;
  amount?: number;
  type?: Transaction['type'];
  category?: string;
  sub_category?: string | null;
  merchant?: string | null;
}

export interface SplitLineInput {
  amount: number;
  type: Transaction['type'];
  category: string;
  sub_category?: string | null;
  merchant?: string | null;
}

export interface TransactionSplit {
  originalId: string;
  lines: SplitLineInput[];
}

export interface SubmitPagePayload {
  pageTransactionIds: string[];
  edits?: TransactionEdit[];
  splits?: TransactionSplit[];
}

export interface SubmitPageResult {
  newSplitChildIds: string[];
}

export async function submitTransactionPage(payload: SubmitPagePayload): Promise<SubmitPageResult> {
  const userId = await getCurrentUserId();
  const { data, error } = await supabase.rpc('submit_transaction_page', {
    p_user_id: userId,
    p_page_ids: payload.pageTransactionIds,
    p_edits: payload.edits ?? [],
    p_splits: payload.splits ?? [],
  });

  if (error) throw error;

  const newSplitChildIds: string[] = (data ?? []).map((row: { id: string }) => row.id);

  for (const id of newSplitChildIds) {
    await runContraDetection(id);
  }

  return { newSplitChildIds };
}

// ─── Reconciliation against custom_categories / registered_facts ────────────
//
// [ADD] matchCustomCategory()/matchRegisteredFact() in smsParser.ts only
// ever run at PARSE time — the moment a new SMS is first turned into a
// transaction row (see classify() there). A custom category confirmed via
// EditModal, or a registered fact confirmed via RegisterFactPrompt, AFTER
// an older transaction was already inserted never gets applied back onto
// that older row — nothing previously re-checked existing uncategorized
// rows against facts/categories added later. This closes that gap.
//
// [FIX — this pass] Originally scoped to status IN ('pending_review',
// 'haiku_suggested'), on the assumption that "uncategorized" and "pending
// review" were the same thing. Confirmed false against real data —
// classify()'s own fallback can land a genuinely uncategorized row as
// status:'approved' with category:null directly. Scoped to category IS
// NULL now instead — see the query below for the full reasoning.
//
// Deliberately reuses smsParser.ts's own matchers rather than
// re-implementing comparison logic here — single source of truth for
// "what counts as a match," same reasoning normaliseMerchantKey() being
// shared (not duplicated) already follows in this codebase.
//
// Call this whenever you want a fresh reconciliation pass — e.g. once per
// app open/mount on the Transactions tab (see index.tsx). Safe to call
// repeatedly: rows that don't match anything are simply left untouched.
export interface ReconcileResult {
  checked:  number;
  resolved: number;
}

export async function reconcilePendingTransactions(): Promise<ReconcileResult> {
  const userId = await getCurrentUserId();

  // [FIX — this pass] Was `.in('status', ['pending_review', 'haiku_suggested'])`
  // — a wrong assumption that "needs classification" and "is pending_review"
  // are the same thing. Confirmed false against real data: classify()'s own
  // fallback path can land a genuinely uncategorized debit as
  // status:'approved', category:null directly (e.g. a P2P transfer to a
  // person's name with no matching TAXONOMY rule) — that row was invisible
  // to this query even though it's exactly the case reconciliation exists
  // to catch. Select on the actual signal instead: category IS NULL, i.e.
  // "never got classified," regardless of what status it happened to land
  // on. Excludes possible_duplicate_of rows — those need an explicit
  // confirm/dismiss from the user regardless of category, and this pass
  // forcing status:'approved' below would wrongly clear that independent
  // review requirement. Excludes user_reviewed — a human already looked at
  // that row; not this pass's place to second-guess it.
  const [{ data: pendingRows, error: fetchError }, customCategories, registeredFacts] = await Promise.all([
    supabase
      .from('transactions')
      .select('id, amount, merchant, ref_number')
      .eq('user_id', userId)
      .eq('is_deleted', false)
      .neq('status', 'user_reviewed')
      .is('category', null)
      .is('possible_duplicate_of', null),
    fetchCustomCategories(),
    fetchActiveRegisteredFacts(),
  ]);

  if (fetchError) throw fetchError;

  type PendingRow = { id: string; amount: number | null; merchant: string | null; ref_number: string | null };
  const rows = (pendingRows ?? []) as PendingRow[];
  if (rows.length === 0) return { checked: 0, resolved: 0 };

  let resolved = 0;

  for (const row of rows) {
    // custom_categories applies to any merchant, credit or debit.
    const customMatch = matchCustomCategory(row.merchant, customCategories);

    // registered_facts only ever applies to debits — mirrors the
    // `!isCredit` gate classify() already uses at parse time, so this
    // reconciliation pass can't resolve a credit row via a registered fact
    // in a way parse-time matching never would have.
    const isCredit = row.amount != null && row.amount >= 0;
    const factMatch: Classification | null =
      !isCredit && row.amount != null
        ? matchRegisteredFact(Math.abs(row.amount), row.merchant, row.ref_number, registeredFacts)
        : null;

    const match = customMatch ?? factMatch;
    if (!match) continue;

    const { error: updateError } = await supabase
      .from('transactions')
      .update({
        type:          match.type,
        category:      match.category,
        sub_category:  match.sub_category,
        status:        'approved',
        parse_failure: null,
        resolved_from: match.resolvedFrom ?? null,
      })
      .eq('id', row.id);

    if (updateError) throw updateError;
    resolved++;
  }

  return { checked: rows.length, resolved };
}

// ─── Manual transaction entry ───────────────────────────────────────────────
//
// [ADD] Direct insert path for user-typed transactions (Add Transaction
// screen), distinct from insertTransaction() above — that function is the
// SMS-ingestion path: it resolves accounts via resolveAccountId(), runs
// duplicate/contra detection, provisional-credit reconciliation, etc., all
// of which assume a ParsedTransaction coming from smsParser.ts. None of
// that applies here — per explicit product decision this session, manual
// entries skip duplicate detection entirely, and the account is already
// known (chosen directly by the user in the form, not inferred from SMS
// text) so resolveAccountId() has nothing to resolve.
//
// Every field below is set deliberately against the real transactions
// table DDL (not guessed from the TS Transaction type, which only reflects
// nullability, not actual constraints):
//   - status: 'user_reviewed' — per product decision, manual entries skip
//     the review queue entirely (they're already fully user-confirmed,
//     there's nothing to review).
//   - source: 'manual' — distinct from the 'cash' value also present in
//     transactions_source_check; 'cash' vs a real bank account is already
//     captured via account_id/accounts.account_type, so source here stays
//     'manual' regardless of which account was chosen. Keeps "how was this
//     entered" (source) and "which account" (account_id) as two separate
//     facts rather than conflating them.
//   - reviewed_at: set to now — mirrors status being immediately
//     'user_reviewed'.
//   - raw_text: null — no source SMS exists for a manual entry.
//   - ref_number/ref_type, possible_contra_of, possible_duplicate_of,
//     duplicate_confidence, resolved_from, parse_failure, txn_group_id,
//     health_module_tag: all omitted (left to their column defaults/null)
//     — none of the detection passes that would populate these ever run
//     for a manual entry.
//   - is_deleted/added_late/is_infrastructure/is_contra: omitted, rely on
//     the DDL's own `default false` for each.
export interface ManualTransactionInput {
  txn_date: string; // 'YYYY-MM-DD'
  /** Signed — positive for money in, negative for money out. Caller
   * computes this via transactionCategories.ts's signedAmount(), same as
   * EditModal/SplitFlow already do, so the sign logic stays in that one
   * place rather than being reimplemented here. */
  amount: number;
  type: 'Expense' | 'Income' | 'Investment' | 'Liability' | 'Asset';
  category: string;
  sub_category: string | null;
  merchant: string | null;
  account_id: string;
}

export async function insertManualTransaction(input: ManualTransactionInput): Promise<{ id: string }> {
  const userId = await getCurrentUserId();
  const merchantKey = input.merchant ? normaliseMerchantKey(input.merchant) : null;

  const { data, error } = await supabase
    .from('transactions')
    .insert({
      user_id:       userId,
      account_id:    input.account_id,
      txn_date:      input.txn_date,
      amount:        input.amount,
      type:          input.type,
      category:      input.category,
      sub_category:  input.sub_category,
      merchant:      input.merchant,
      merchant_key:  merchantKey,
      source:        'manual',
      status:        'user_reviewed',
      reviewed_at:   new Date().toISOString(),
      raw_text:      null,
    })
    .select('id')
    .single();

  if (error) throw error;
  return { id: data.id };
}