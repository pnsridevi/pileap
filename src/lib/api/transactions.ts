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
 */

import { supabase } from '../supabase';
import type { ParsedTransaction, BalanceUpdate } from '../smsParser';
import { isBalanceUpdate } from '../smsParser';

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

// Sentinel used to identify the one placeholder "Unknown" account per user,
// distinct from any real bank/CC account number. Kept short/fixed so the
// lookup below is a plain equality check, not a fuzzy match.
const UNKNOWN_ACCOUNT_SENTINEL = 'UNKNOWN';

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

async function resolveUnknownAccountId(userId: string): Promise<string> {
  const { data: existing, error: lookupError } = await supabase
    .from('accounts')
    .select('id')
    .eq('user_id', userId)
    .eq('account_number_masked', UNKNOWN_ACCOUNT_SENTINEL)
    .maybeSingle();

  if (lookupError) throw lookupError;
  if (existing) return existing.id;

  const { data: created, error: insertError } = await supabase
    .from('accounts')
    .insert({
      user_id: userId,
      account_type: 'bank',
      institution_name: 'Unknown',
      account_number_masked: UNKNOWN_ACCOUNT_SENTINEL,
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

interface DuplicateCandidate {
  id: string;
  ref_number: string | null;
}

async function findDuplicateCandidate(
  userId: string,
  accountId: string,
  txnDate: string,
  amount: number,
): Promise<DuplicateCandidate | null> {
  const { data: active, error: activeError } = await supabase
    .from('transactions')
    .select('id, ref_number')
    .eq('user_id', userId)
    .eq('account_id', accountId)
    .eq('txn_date', txnDate)
    .eq('amount', amount)
    .eq('is_deleted', false)
    .eq('is_contra', false)
    .in('status', ['pending_review', 'approved'])
    .order('created_at', { ascending: true })
    .limit(1);

  if (activeError) throw activeError;
  if (active && active.length > 0) return active[0];

  const { data: history, error: historyError } = await supabase
    .from('transactions')
    .select('id, ref_number')
    .eq('user_id', userId)
    .eq('account_id', accountId)
    .eq('txn_date', txnDate)
    .eq('amount', amount)
    .eq('is_deleted', false)
    .eq('is_contra', false)
    .eq('status', 'user_reviewed')
    .order('created_at', { ascending: true })
    .limit(1);

  if (historyError) throw historyError;
  if (history && history.length > 0) return history[0];

  return null;
}

/**
 * Rough confidence signal for the UI, not a hard rule — the user always
 * confirms/dismisses regardless of this number, per product decision.
 * Same ref_number as the candidate (rare — usually means the same SMS
 * arrived twice) scores much higher than a same account/date/amount match
 * with a different or absent ref_number (plausibly two real, separate
 * transactions that just happen to share amount and date).
 */
function computeDuplicateConfidence(
  newRefNumber: string | null,
  candidateRefNumber: string | null,
): number {
  if (newRefNumber && candidateRefNumber && newRefNumber === candidateRefNumber) {
    return 0.95;
  }
  return 0.6;
}

// ─── Transaction inserts ──────────────────────────────────────────────────────

const DEFINITIONAL_CONTRA_RULES = new Set([
  'GENERIC_CC_PAYMENT',
  'PLUXEE_CREDIT',
  'NCMC_LOAD',
  'GENERIC_PPF_SSY',
  'CASH_DEPOSIT',
  'WALLET_LOAD',
]);

async function insertTransaction(txn: ParsedTransaction, userId: string): Promise<{ id: string; skipPairing: boolean }> {
  const accountId = txn.account_number_masked
    ? await resolveAccountId(txn.account_number_masked, txn.bank, txn.channel, userId)
    : await resolveUnknownAccountId(userId);

  // [FIX] resolveAccountId() returns string|null (null only when its own
  // accountNumberMasked argument is falsy), while resolveUnknownAccountId()
  // always returns string. TypeScript can't see that this ternary's
  // resolveAccountId branch only runs when txn.account_number_masked is
  // truthy — the one case where resolveAccountId is guaranteed non-null —
  // so accountId's inferred type stays string|null overall, which
  // findDuplicateCandidate() (below) and the insert payload both need as a
  // plain string. This guard narrows the type AND is real safety, not just
  // a type-checker workaround: arch doc Table 23 requires account_id to
  // never be null, so a thrown error here is the correct behaviour if that
  // guarantee is ever actually violated, rather than silently inserting a
  // bad value.
  if (!accountId) {
    throw new Error(
      `resolveAccountId returned null for a truthy account_number_masked ("${txn.account_number_masked}") — this should be unreachable.`
    );
  }

  const isDefinitionalContra = !!(txn.matched_rule && DEFINITIONAL_CONTRA_RULES.has(txn.matched_rule));

  // [NEW — this pass] Check for a possible duplicate BEFORE inserting, so
  // possible_duplicate_of/duplicate_confidence can be set in the same
  // INSERT rather than a follow-up UPDATE. Skipped for definitional-contra
  // rows (a recurring credit-card bill payment at the same amount every
  // month is EXPECTED to repeat — flagging those as "duplicates" would be
  // noise) and skipped when amount is null (declined-transaction
  // placeholders — nothing meaningful to match on).
  const duplicateCandidate =
    (!isDefinitionalContra && txn.amount !== null)
      ? await findDuplicateCandidate(userId, accountId, txn.txn_date, txn.amount)
      : null;

  const duplicateConfidence = duplicateCandidate
    ? computeDuplicateConfidence(txn.ref_number, duplicateCandidate.ref_number)
    : null;

  // Per arch doc Table 23: account_id must not be null; if the parser
  // couldn't extract a real account number, route to pending_review
  // regardless of what the parser's own status said. A possible duplicate
  // ALSO forces pending_review, regardless of what the parser said —
  // duplicates are never auto-approved, the user always decides.
  const status =
    !txn.account_number_masked || duplicateCandidate
      ? 'pending_review'
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
    is_deleted:            false,
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
  ref_number: string | null;
  ref_type: string | null;
  status: string;
  is_infrastructure: boolean;
  is_contra: boolean;
  possible_contra_of: string | null;
  txn_group_id: string | null;
}

const TXN_SELECT_COLS =
  'id, user_id, account_id, txn_date, amount, ref_number, ref_type, status, is_infrastructure, is_contra, possible_contra_of, txn_group_id';

export async function runContraDetection(newTxnId: string, _depth = 0): Promise<void> {
  if (_depth > 5) return;

  const { data: txn, error: fetchError } = await supabase
    .from('transactions')
    .select(TXN_SELECT_COLS)
    .eq('id', newTxnId)
    .single<TxnRow>();

  if (fetchError) throw fetchError;
  if (!txn || txn.is_infrastructure || txn.is_contra) return;

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
    .returns<TxnRow[]>();

  if (activeError) throw activeError;

  const differentAccount = (c: TxnRow) =>
    !(txn.account_id && c.account_id && txn.account_id === c.account_id);

  const eligible = (activeCandidates ?? []).filter(differentAccount);

  if (eligible.length > 0) {
    const tier1Match = eligible.find(c =>
      txn.account_id && c.account_id &&
      txn.ref_number && c.ref_number && txn.ref_number === c.ref_number
    );
    if (tier1Match) { await applyContraMatch(txn, tier1Match, 'tier1', _depth); return; }

    const tier2Match = eligible.find(c => txn.account_id && c.account_id);
    if (tier2Match) { await applyContraMatch(txn, tier2Match, 'tier2', _depth); return; }

    await applyContraMatch(txn, eligible[0], 'tier3', _depth);
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
    .returns<TxnRow[]>();

  if (historyError) throw historyError;

  const historyMatch = (historyCandidates ?? []).filter(differentAccount)[0];
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
    const groupId = partner.txn_group_id || txn.txn_group_id || crypto.randomUUID();
    await supabase.from('transactions').update({ is_contra: true, txn_group_id: groupId, possible_contra_of: null }).eq('id', txn.id);
    await supabase.from('transactions').update({ is_contra: true, txn_group_id: groupId, possible_contra_of: null }).eq('id', partner.id);

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
  errors: { raw_sms_id: string; message: string }[];
}

export async function ingestParsedMessages(
  items: (ParsedTransaction | BalanceUpdate)[],
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
    errors: [],
  };

  let processed = 0;

  for (const item of items) {
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
    } catch (e) {
      result.errors.push({
        raw_sms_id: item.raw_sms_id,
        message: getErrorMessage(e),
      });
    }

    processed++;
    if (processed % 10 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  return result;
}

// ─── Fetch for the Transactions tab ───────────────────────────────────────────

export interface TransactionFilters {
  status?:  'approved' | 'pending_review' | 'user_reviewed';
  statuses?: ('approved' | 'pending_review' | 'user_reviewed')[];
  category?: string;
  page?:     number;
  pageSize?: number;
}

export async function fetchTransactions(filters: TransactionFilters = {}) {
  const { status, statuses, category, page = 0, pageSize = 20 } = filters;
  const userId = await getCurrentUserId();

  let query = supabase
    .from('transactions')
    .select('*', { count: 'exact' })
    .eq('user_id', userId)
    .eq('is_deleted', false)
    .order('txn_date', { ascending: false })
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
  txn_date: string;
  amount: number;
  type: 'Expense' | 'Income' | 'Investment' | 'Liability' | 'Asset';
  category: string;
  sub_category: string | null;
  merchant: string | null;
  merchant_key: string | null;
  source: 'sms' | 'email' | 'manual' | 'pdf' | 'cash' | 'haiku';
  status: 'pending_review' | 'approved' | 'user_reviewed';
  reviewed_at: string | null;
  raw_text: string | null;
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
    .eq('status', 'pending_review');

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
  const groupId = crypto.randomUUID();
  await supabase.from('transactions')
    .update({ is_contra: true, txn_group_id: groupId, possible_contra_of: null })
    .eq('id', txnId);
  await supabase.from('transactions')
    .update({ is_contra: true, txn_group_id: groupId, possible_contra_of: null })
    .eq('id', partnerId);
}

export async function confirmContraAgainstHistoryMatch(txnId: string): Promise<void> {
  await supabase.from('transactions')
    .update({ is_contra: true, txn_group_id: crypto.randomUUID(), possible_contra_of: null })
    .eq('id', txnId);
}

export async function dismissContraPair(txnId: string): Promise<void> {
  const { data: txn, error } = await supabase
    .from('transactions')
    .select('possible_contra_of')
    .eq('id', txnId)
    .single();
  if (error) throw error;

  await supabase.from('transactions').update({ possible_contra_of: null }).eq('id', txnId);
  if (txn?.possible_contra_of) {
    await supabase.from('transactions').update({ possible_contra_of: null }).eq('id', txn.possible_contra_of);
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