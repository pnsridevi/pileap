// supabase/functions/haiku-collect/index.ts
//
// Runs on a schedule (suggested every 30 min — see README). Finds
// in-flight batches, and for each candidate result:
//
//   1. Looks up whether a sibling `transactions` row already exists,
//      via (user_id, raw_sms_id, raw_text) — the same identity key
//      findGenuineResyncMatch() in transactions.ts already uses, so this
//      is consistent with the app's own duplicate-safe join, not a new
//      invented key.
//
//   2a. SIBLING EXISTS (the common case — missing_amount, unknown_direction
//       from parseSingleSms(), escalated_to_haiku all guarantee this):
//       conditionally UPDATE it, but ONLY while it's still 'pending_review'.
//       If a human (or reconcilePendingTransactions()'s unrelated
//       auto-approve pass) already moved it off pending_review, the
//       update matches zero rows and Haiku's answer is correctly thrown
//       away — human review always wins, no exceptions, by construction
//       of the WHERE clause, not by checking "did someone review this"
//       as a separate step that could race.
//
//   2b. NO SIBLING (the Layer-1-only case — logLayer1Candidates() never
//       inserts a row): if Haiku extracted both amount and direction,
//       insert a plain new row. Otherwise drop it — no complex checks,
//       per the explicit "keep this simple" decision in the design chat.
//
// Deliberately NOT implemented here (see the design chat for why):
//   - Re-running full duplicate detection (findDuplicateCandidate) after
//     an update. That logic is inlined inside insertTransaction() in the
//     app and would need extracting into something reusable first — real
//     work, and the failure mode (an unflagged duplicate) is the same
//     "nothing catches it, same as today" risk the app already tolerates
//     elsewhere. Deferred, not forgotten.
//
// PORTED, NOT REUSED — read this before touching contra logic:
//   runContraDetection() lives in the mobile app's transactions.ts and
//   depends on a signed-in user's Supabase session (auth.uid()). This
//   Edge Function runs as a backend job across all users with the
//   service-role key — there is no session to depend on, so the app's
//   function literally cannot be imported here. What follows is a
//   PORT of its Tier 1/2 logic, not a call to the same code. Two
//   deliberate simplifications from the real version, flagged so nobody
//   mistakes this for identical behavior:
//     - Tier 3 (weakest tier — "nothing better exists" fallback) is NOT
//       ported. Only Tier 1 (exact ref_number+ref_type) and Tier 2 (same
//       account + merchant match) run here.
//     - Merchant matching uses exact string equality on merchant_key,
//       not the real merchantSimilarity() fuzzy-ratio function (that
//       function isn't ported here — doing so faithfully was judged not
//       worth the risk of a subtly-wrong reimplementation for this
//       pass). This means some real fuzzy-name matches (e.g. "SRI DEVI P
//       N" vs "SRIDEVI P N") that the app's real contra detection would
//       catch will be MISSED here. Under-matching, not over-matching —
//       the safer direction to be wrong in, but worth knowing.
//   If this drifts from the real transactions.ts implementation over
//   time, this file needs manual re-syncing — there is no shared source
//   of truth between them.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;

// Same window reconcileProvisionalCredit()/findExistingConfirmingCredit()
// already use in transactions.ts — kept identical on purpose, not
// re-derived, so behavior is consistent between the deterministic path
// and this Haiku-sourced path.
const PROVISIONAL_RECONCILE_WINDOW_DAYS = 15;

// [ADD] A mechanical backstop independent of prompt wording. Real
// example that motivated this: a promotional plan-description SMS
// ("your Rs 999 plan includes...") got misclassified as a debit at
// confidence 0.65 — Haiku itself was already hedging, but nothing was
// checking that number before writing it to `transactions`. Below this
// threshold, treat the result the same as if amount/direction had come
// back null: don't touch transactions, log it as unresolved. Tune this
// number as real accuracy data comes in — 0.75 is a starting point, not
// a validated figure.
const MIN_CONFIDENCE_TO_APPLY = 0.75;

function normaliseMerchantKey(merchant: string | null): string | null {
  if (!merchant) return null;
  return merchant.toLowerCase().replace(/[^a-z0-9@]/g, '').substring(0, 40) || null;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

interface CandidateRow {
  id: string;
  user_id: string;
  raw_sms_id: string;
  raw_text: string;
  txn_date: string;
  haiku_group_id: string | null;
}

interface Classification {
  raw_sms_id: string;
  is_transaction: boolean;
  direction: 'credit' | 'debit' | null;
  amount: number | null;
  currency: string | null;
  merchant: string | null;
  is_provisional_notice: boolean | null;
  confidence: number;
}

// Slim Tier 1 / Tier 2 contra re-check. See file header for exactly what
// this does and doesn't cover relative to the real runContraDetection().
async function reCheckContra(supabase: any, txnId: string): Promise<void> {
  const { data: txn } = await supabase
    .from('transactions')
    .select('id, user_id, account_id, txn_date, amount, type, ref_number, ref_type, is_infrastructure, is_contra, merchant_key')
    .eq('id', txnId)
    .maybeSingle();

  if (!txn || txn.is_infrastructure || txn.is_contra || txn.type === 'Income' || txn.amount === null) return;

  const dateFrom = addDays(txn.txn_date, -1);
  const dateTo = addDays(txn.txn_date, 1);

  const { data: candidates } = await supabase
    .from('transactions')
    .select('id, account_id, ref_number, ref_type, merchant_key, status')
    .eq('user_id', txn.user_id)
    .eq('is_deleted', false)
    .eq('is_infrastructure', false)
    .eq('is_contra', false)
    .neq('id', txn.id)
    .eq('amount', -txn.amount)
    .gte('txn_date', dateFrom)
    .lte('txn_date', dateTo)
    .in('status', ['pending_review', 'approved']);

  if (!candidates || candidates.length === 0) return;

  const tier1 = candidates.find((c: any) =>
    txn.account_id && c.account_id &&
    txn.ref_number && c.ref_number && txn.ref_number === c.ref_number &&
    txn.ref_type && c.ref_type && txn.ref_type === c.ref_type
  );
  if (tier1) {
    const groupId = crypto.randomUUID();
    await supabase.from('transactions').update({ is_contra: true, txn_group_id: groupId, possible_contra_of: null, status: 'approved' }).eq('id', txn.id).neq('status', 'user_reviewed');
    await supabase.from('transactions').update({ is_contra: true, txn_group_id: groupId, possible_contra_of: null, status: 'approved' }).eq('id', tier1.id).neq('status', 'user_reviewed');
    return;
  }

  const tier2 = candidates.find((c: any) =>
    txn.account_id && c.account_id &&
    txn.merchant_key && c.merchant_key && txn.merchant_key === c.merchant_key
  );
  if (tier2) {
    await supabase.from('transactions').update({ possible_contra_of: tier2.id }).eq('id', txn.id);
  }
}

// New — the "ask Haiku itself" provisional-notice check from the design
// chat. Deliberately NOT calling reconcileProvisionalCredit()/
// findExistingConfirmingCredit() (same cross-runtime reason as contra
// detection above), and deliberately NOT auto-hiding on a match — this
// links via possible_duplicate_of and leaves the row pending_review, so
// a human confirms/dismisses through the existing duplicate-review UI,
// rather than trusting an untested Haiku judgment to silently delete a
// transaction. Auto-hide can be revisited once real data shows this
// classification is reliable.
async function checkProvisionalNotice(supabase: any, userId: string, txnDate: string, amount: number): Promise<string | null> {
  const latestDate = addDays(txnDate, PROVISIONAL_RECONCILE_WINDOW_DAYS);
  const earliestDate = addDays(txnDate, -PROVISIONAL_RECONCILE_WINDOW_DAYS);

  const { data } = await supabase
    .from('transactions')
    .select('id')
    .eq('user_id', userId)
    .eq('amount', amount)
    .eq('is_deleted', false)
    .is('parse_failure', null) // a real, already-confirmed transaction, not another placeholder
    .gte('txn_date', earliestDate)
    .lte('txn_date', latestDate)
    .order('created_at', { ascending: true })
    .limit(1);

  return data && data.length > 0 ? data[0].id : null;
}

async function applyResult(supabase: any, candidate: CandidateRow, result: Classification, usage: Record<string, unknown>): Promise<void> {
  // [ADD] Every haiku_response write below now stores { classification,
  // usage } instead of just the classification. `usage` is the whole
  // GROUP's token counts (input/output/cache_creation/cache_read), from
  // the single API call that produced this candidate's answer alongside
  // up to 24 others in the same group — it's duplicated onto each row in
  // the group rather than being a group-level-only value, specifically so
  // it's queryable per-candidate with no joins needed, e.g.:
  //   select id, haiku_response->'usage' from haiku_candidate_log ...
  const responsePayload = { classification: result, usage };
  try {
    // [CHANGED] is_transaction is now a guaranteed field on every entry
    // (see haiku-submit) — every raw_sms_id sent always gets exactly one
    // entry back, so this is a real, explicit "not a transaction" call
    // from Haiku, not an inferred one from an entry being absent.
    if (!result.is_transaction) {
      await supabase.from('haiku_candidate_log').update({
        haiku_status: 'dropped_unresolvable', haiku_response: responsePayload, haiku_processed_at: new Date().toISOString(),
      }).eq('id', candidate.id);
      return;
    }

    // Confidence gate — the real backstop against the "plausible-looking
    // but wrong" class of error, independent of whatever the prompt does
    // or doesn't catch. Applied right after is_transaction, before
    // anything else, so a low-confidence result never reaches the
    // transactions table regardless of how plausible the rest looks.
    if (result.confidence < MIN_CONFIDENCE_TO_APPLY) {
      await supabase.from('haiku_candidate_log').update({
        haiku_status: 'dropped_unresolvable', haiku_response: responsePayload, haiku_processed_at: new Date().toISOString(),
      }).eq('id', candidate.id);
      return;
    }

    // [CURRENCY] If Haiku flags a non-INR currency, deliberately do NOT
    // write result.amount into transactions.amount — that field is INR
    // by schema convention, and writing a foreign face-value number into
    // it unconverted is the exact bug this whole pipeline traces back to
    // (see the smsParser.ts forex handling discussed in the design chat).
    // No live exchange-rate lookup exists yet (needs its own schema
    // columns + a real FX-rate API call — a deliberate, not-yet-built
    // decision). Until that's added: treat this like "amount unresolved"
    // — merchant/direction/provisional-notice still get applied below,
    // but signedAmount stays null so the amount column is left alone
    // rather than silently wrong.
    const isForeignCurrency = !!(result.currency && result.currency.toUpperCase() !== 'INR');
    const signedAmount = result.amount === null || result.direction === null || isForeignCurrency
      ? null
      : result.direction === 'credit' ? Math.abs(result.amount) : -Math.abs(result.amount);

    // Step 1: does a sibling transaction already exist for this exact SMS?
    const { data: sibling } = await supabase
      .from('transactions')
      .select('id')
      .eq('user_id', candidate.user_id)
      .eq('raw_sms_id', candidate.raw_sms_id)
      .eq('raw_text', candidate.raw_text)
      .not('is_deleted', 'is', true)
      .maybeSingle();

    if (sibling) {
      // The race guard: only apply while still pending_review. See file
      // header — this is what makes human review (or the unrelated
      // reconcilePendingTransactions() auto-approve pass) always win,
      // unconditionally, with no separate "check first" step to race.
      const updatePayload: Record<string, unknown> = {
        status: 'haiku_suggested',
        merchant: result.merchant,
        merchant_key: normaliseMerchantKey(result.merchant),
      };
      if (signedAmount !== null) updatePayload.amount = signedAmount;
      if (result.is_provisional_notice) {
        updatePayload.parse_failure = 'awaiting_bank_confirmation';
        updatePayload.status = 'pending_review'; // keep visible + reviewable, don't auto-hide
      }

      const { data: updated, error: updateError } = await supabase
        .from('transactions')
        .update(updatePayload)
        .eq('id', sibling.id)
        .eq('status', 'pending_review')
        .select('id');

      if (updateError) throw updateError;

      if (!updated || updated.length === 0) {
        await supabase.from('haiku_candidate_log').update({
          haiku_status: 'skipped_already_reviewed', haiku_response: responsePayload, haiku_processed_at: new Date().toISOString(),
        }).eq('id', candidate.id);
        return;
      }

      if (result.is_provisional_notice && signedAmount !== null) {
        const matchId = await checkProvisionalNotice(supabase, candidate.user_id, candidate.txn_date, signedAmount);
        if (matchId) {
          await supabase.from('transactions').update({
            possible_duplicate_of: matchId, duplicate_confidence: 0.7,
          }).eq('id', sibling.id);
        }
        // No match yet: row stays parse_failure='awaiting_bank_confirmation',
        // pending_review. The app's EXISTING reconcileProvisionalCredit()
        // will find and resolve it automatically once the real confirming
        // transaction syncs in later — no new code needed for that half.
      } else {
        await reCheckContra(supabase, sibling.id);
      }

      await supabase.from('haiku_candidate_log').update({
        haiku_status: 'done_updated', haiku_response: responsePayload, haiku_processed_at: new Date().toISOString(),
      }).eq('id', candidate.id);
      return;
    }

    // Step 2: no sibling — Layer-1 origin. Insert-or-drop, no complex checks.
    if (signedAmount === null) {
      await supabase.from('haiku_candidate_log').update({
        haiku_status: 'dropped_unresolvable', haiku_response: responsePayload, haiku_processed_at: new Date().toISOString(),
      }).eq('id', candidate.id);
      return;
    }

    const { error: insertError } = await supabase.from('transactions').insert({
      user_id: candidate.user_id,
      account_id: null, // unknown — vendor/Layer-1 messages rarely state an account
      txn_date: candidate.txn_date,
      amount: signedAmount,
      type: null,
      category: null,
      sub_category: null,
      merchant: result.merchant,
      merchant_key: normaliseMerchantKey(result.merchant),
      source: 'sms',
      status: 'haiku_suggested',
      raw_text: candidate.raw_text,
      raw_sms_id: candidate.raw_sms_id,
      is_deleted: false,
      added_late: false,
      is_contra: false,
      is_infrastructure: false,
      parse_failure: null,
    });

    if (insertError) throw insertError;

    await supabase.from('haiku_candidate_log').update({
      haiku_status: 'done_inserted', haiku_response: responsePayload, haiku_processed_at: new Date().toISOString(),
    }).eq('id', candidate.id);
  } catch (e) {
    // Never let one bad row take down the whole collect run.
    await supabase.from('haiku_candidate_log').update({
      haiku_status: 'failed', haiku_error: String((e as Error)?.message ?? e), haiku_processed_at: new Date().toISOString(),
    }).eq('id', candidate.id);
  }
}

Deno.serve(async () => {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: sentRows, error } = await supabase
    .from('haiku_candidate_log')
    .select('haiku_batch_id')
    .eq('haiku_status', 'sent');

  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  const batchIds = [...new Set((sentRows ?? []).map((r: any) => r.haiku_batch_id).filter(Boolean))];
  if (batchIds.length === 0) {
    return new Response(JSON.stringify({ message: 'no in-flight batches' }), { status: 200 });
  }

  let processedBatches = 0, processedCandidates = 0;

  for (const batchId of batchIds) {
    const statusResp = await fetch(`https://api.anthropic.com/v1/messages/batches/${batchId}`, {
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    });
    if (!statusResp.ok) continue; // transient — retried next run

    const batch = await statusResp.json();
    if (batch.processing_status !== 'ended') continue; // still running, check again next time

    const resultsResp = await fetch(batch.results_url, {
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    });
    if (!resultsResp.ok) continue;

    const resultsText = await resultsResp.text();
    const lines = resultsText.trim().split('\n').filter(Boolean);

    for (const line of lines) {
      const entry = JSON.parse(line);
      const groupId = entry.custom_id;

      const { data: groupCandidates } = await supabase
        .from('haiku_candidate_log')
        .select('id, user_id, raw_sms_id, raw_text, txn_date, haiku_group_id')
        .eq('haiku_group_id', groupId)
        .eq('haiku_status', 'sent');

      if (!groupCandidates || groupCandidates.length === 0) continue;

      if (entry.result?.type !== 'succeeded') {
        // API-level failure for this whole group (rate limit, etc). Mark
        // every candidate in it 'failed' with the reason — next manual
        // fix is to reset them to 'pending' for haiku-submit to retry.
        const errMsg = JSON.stringify(entry.result);
        await supabase.from('haiku_candidate_log').update({
          haiku_status: 'failed', haiku_error: errMsg, haiku_processed_at: new Date().toISOString(),
        }).eq('haiku_group_id', groupId);
        continue;
      }

      const toolUseBlock = entry.result.message.content.find((b: any) => b.type === 'tool_use');
      const classifications: Classification[] = toolUseBlock?.input?.results ?? [];
      // [ADD] entry.result.message.usage carries the real token counts
      // for this one group's API call: input_tokens, output_tokens, and
      // (if prompt caching kicked in) cache_creation_input_tokens /
      // cache_read_input_tokens — the actual field names to watch to
      // confirm caching is working as intended, not just assumed.
      const usage = entry.result.message.usage ?? {};

      const byRawSmsId = new Map(classifications.map((c) => [c.raw_sms_id, c]));

      for (const candidate of groupCandidates as CandidateRow[]) {
        const result = byRawSmsId.get(candidate.raw_sms_id);
        if (!result) {
          // [CHANGED — reverted] Every message is now guaranteed exactly
          // one entry via is_transaction (see haiku-submit) — a missing
          // entry can no longer mean "correctly identified as non-
          // transactional," since that case now comes back explicitly as
          // is_transaction:false and is handled inside applyResult(). A
          // raw_sms_id genuinely absent from the results here means the
          // model didn't follow the "return exactly one entry per
          // message" instruction — a real anomaly worth surfacing as
          // 'failed', not silently treating it as a safe default.
          await supabase.from('haiku_candidate_log').update({
            haiku_status: 'failed',
            haiku_error: 'no entry returned for this raw_sms_id despite one-entry-per-message being required',
            haiku_processed_at: new Date().toISOString(),
          }).eq('id', candidate.id);
          continue;
        }
        await applyResult(supabase, candidate, result, usage);
        processedCandidates++;
      }
    }
    processedBatches++;
  }

  return new Response(JSON.stringify({ batches_processed: processedBatches, candidates_processed: processedCandidates }), { status: 200 });
});